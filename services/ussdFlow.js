/**
 * ussdFlow.js — ShambAI Evidence Discovery Engine (v2)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PHILOSOPHY
 * ─────────────────────────────────────────────────────────────────────────────
 * This system does NOT score farmers. It discovers evidence.
 * Every answer becomes a graph node. Every relationship becomes a signal.
 * We do not punish missing collateral. We find what traditional lenders cannot see.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FLOW ARCHITECTURE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Africa's Talking accumulates all keypresses into `text`:
 *   "" → "1" → "1*2" → "1*2*3" ...
 * We split on '*' and route by depth + choices.
 *
 * FLOW A — New assessment (text starts with "1"):
 *   Q1 → consent         (M-Pesa data access)
 *   Q2 → farmAccess      (how farmer accesses land — not "do you own land?")
 *   Q3 → cropType        (what they grow — triggers ADAPTIVE branch for dairy)
 *         ↳ DAIRY ONLY: Q3a → herdSize, Q3b → milkCooperative
 *         ↳ OTHER:      Q3a → farmSeason
 *   Q4 → communityTies   (cooperative / savings group / SACCO — key evidence)
 *         ↳ If chama/SACCO → skip loanHistory formal question, use group record
 *         ↳ If none       → ask loanHistory
 *   Q5 → loanHistory     (only asked if no community finance evidence)
 *   Q6 → inputAccess     (do they buy seeds/fertilizer regularly? = spending pattern)
 *   Q7 → confirm
 *
 * FLOW B — View result (PIN-gated): same as v1 with enhanced evidence display
 * FLOW C — Credit education:        same as v1
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ADAPTIVE LOGIC
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * cropType === 'dairy'
 *   → insert Q_herdSize + Q_milkCoop instead of Q_farmSeason
 *   → herd size proxies for asset base (replaces collateral question)
 *   → milk cooperative = repayment network evidence
 *
 * communityTies in ['chama', 'sacco', 'coop']
 *   → skip Q_loanHistory entirely (we fetch group repayment data from Neo4j)
 *   → community finance IS the loan history
 *
 * farmAccess === 'leased'
 *   → insert Q_leaseLength (lease > 3 seasons = stable tenure evidence)
 *   → replaces collateral question without asking about title deeds
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NEO4J NODES CREATED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   (:Farmer)            — phoneHash, location, crop, scoredAt
 *   (:FarmTenure)        — type: owned/leased/shared/family, leaseLength?
 *   (:CropActivity)      — cropType, season, herdSize?, cooperativeMilk?
 *   (:CommunityGroup)    — type: chama/sacco/coop/none, name?
 *   (:LoanRecord)        — outcome: repaid_full/partial/defaulted/chama/none
 *   (:InputPurchase)     — frequency: never/sometimes/always
 *   (:MPesaConsent)      — granted: true/false
 *
 * RELATIONSHIPS:
 *   (Farmer)-[:HAS_TENURE]->(FarmTenure)
 *   (Farmer)-[:GROWS]->(CropActivity)
 *   (Farmer)-[:MEMBER_OF]->(CommunityGroup)
 *   (CommunityGroup)-[:HAS_REPAYMENT_RECORD]->(LoanRecord)
 *   (Farmer)-[:PURCHASED_INPUTS]->(InputPurchase)
 *   (Farmer)-[:GRANTED_CONSENT]->(MPesaConsent)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const {
  getSession,
  saveSession,
  deleteSession,
  getFarmerRecord,
  saveFarmerRecord,
} = require('../db/sessionStore');
const { buildSMS, buildUSSDDetail, buildRepaymentLink } = require('./explainer');
const { writeFarmerNode, writeEvidenceGraph } = require('../db/neo4j');
const { hashPhone } = require('../db/sessionStore');
const { sendSMS } = require('./smsService');
const { initiateRiskAssessment } = require('./riskEngine');

// ═══════════════════════════════════════════════════════════════════════════════
// ADAPTIVE SEQUENCE ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Computes the question sequence dynamically based on answers collected so far.
 * Returns an ordered array of question keys the current farmer should answer.
 *
 * This is the heart of the adaptive system. Instead of a fixed array,
 * we derive the sequence from business rules at runtime.
 *
 * @param {Object} answers - answers collected so far
 * @returns {string[]} - ordered question keys
 */
function computeSequence(answers = {}) {
  const seq = ['consent', 'location', 'farmAccess'];

  // Lease follow-up: if farmer leases, ask how long (stability evidence)
  if (answers.farmAccess === 'leased') {
    seq.push('leaseLength');
  }

  seq.push('cropType');

  // Dairy branch: swap out season question for herd + milk cooperative
  if (answers.cropType === 'dairy') {
    seq.push('herdSize');
    seq.push('milkCooperative');
  } else {
    seq.push('farmSeason');
  }

  seq.push('communityTies');

  // Community finance bridge:
  // If they have a chama/sacco/coop → skip loanHistory (their group IS the record)
  // If they have no community ties → loanHistory is the only formal evidence we can seek
  const hasGroupFinance = ['chama', 'sacco', 'coop'].includes(answers.communityTies);
  if (!hasGroupFinance) {
    seq.push('loanHistory');
  }

  seq.push('inputAccess');

  return seq;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * All USSD screens written in informal Kenyan Swahili.
 * Every screen must fit in ~160 characters for feature phones.
 * NO sensitive demographic questions (no gender, tribe, religion, marital status).
 * Gender is collected ONLY via a separate optional analytics flow — never in scoring.
 */
const S = {
  // ── Main menu ──────────────────────────────────────────────────────────────
  main: () =>
    `CON Karibu ShambAI 🌱\n` +
    `Tunakusaidia kupata mkopo.\n\n` +
    `1. Omba tathmini\n` +
    `2. Matokeo yangu\n` +
    `3. Elimu ya mkopo\n` +
    `0. Toka`,

  // ── Q1: M-Pesa consent ────────────────────────────────────────────────────
  // Why: M-Pesa history is our strongest thin-file alternative signal.
  // Without consent we still score, but confidence drops and we note the gap.
  // Node: (:MPesaConsent {granted: true/false})
  consent: () =>
    `CON Tunaweza kuangalia historia ya M-Pesa yako?\n` +
    `Itatusaidia kupata mkopo bora.\n\n` +
    `1. Ndio, nakubali\n` +
    `2. Hapana`,

  // ── Q2: Location ──────────────────────────────────────────────────────────
  // Why: County links to rainfall data, market access, and known cooperative networks.
  // Neo4j: (:Farmer)-[:LOCATED_IN]->(:County {name, rainfallZone, cooperatives[]})
  location: () =>
    `CON Shamba lako liko kaunti gani?\n\n` +
    `1. Kiambu\n` +
    `2. Murang'a\n` +
    `3. Machakos\n` +
    `4. Nakuru\n` +
    `5. Nyeri\n` +
    `6. Nyingine`,

  // ── Q3: Farm access (NOT "do you own land?") ──────────────────────────────
  // Why: Ownership language alienates women on family land and leasehold farmers.
  //      Instead we ask HOW they access — which uncovers tenure stability.
  //      "Family land" + "long time" = stable as owned. "Leased" = ask follow-up.
  // Node: (:FarmTenure {type, leaseLength?})
  farmAccess: () =>
    `CON Unafanya kazi shambani vipi?\n\n` +
    `1. Shamba langu mwenyewe\n` +
    `2. Shamba la familia\n` +
    `3. Napangisha\n` +
    `4. Nashiriki na wengine`,

  // ── Q3a (adaptive, only if leased): Lease stability ──────────────────────
  // Why: A 3+ season lease = de facto stable tenure. Replaces title deed requirement.
  // Node: Updates (:FarmTenure {leaseLength: 'short'|'medium'|'long'})
  leaseLength: () =>
    `CON Umepanga shamba hilo kwa muda gani?\n\n` +
    `1. Chini ya mwaka 1\n` +
    `2. Miaka 1-3\n` +
    `3. Zaidi ya miaka 3`,

  // ── Q4: Crop type ─────────────────────────────────────────────────────────
  // Why: Determines income cycle, risk profile, and triggers dairy adaptive branch.
  // Node: (:CropActivity {cropType, season?})
  cropType: () =>
    `CON Unafanya nini shambani hasa?\n\n` +
    `1. Mahindi / Maharagwe\n` +
    `2. Ng'ombe / Maziwa\n` +
    `3. Mboga / Matunda\n` +
    `4. Mchanganyiko`,

  // ── Q4a (dairy only): Herd size ───────────────────────────────────────────
  // Why: Livestock = asset base. Replaces collateral question for dairy farmers.
  //      Herd size proxies for economic stability without asking for title deeds.
  // Node: Updates (:CropActivity {herdSize: 'small'|'medium'|'large'})
  herdSize: () =>
    `CON Una ng'ombe / mbuzi wangapi?\n\n` +
    `1. 1-2\n` +
    `2. 3-5\n` +
    `3. 6-10\n` +
    `4. Zaidi ya 10`,

  // ── Q4b (dairy only): Milk cooperative ───────────────────────────────────
  // Why: Milk cooperative = regular structured payments = repayment behavior proxy.
  //      Stronger evidence than many formal loan records.
  // Node: (:CommunityGroup {type:'milk_coop'})-[:HAS_PAYMENT_RECORD]->(:CropActivity)
  milkCooperative: () =>
    `CON Unauza maziwa kupitia ushirika?\n\n` +
    `1. Ndio, kila mwezi\n` +
    `2. Ndio, wakati mwingine\n` +
    `3. Hapana, mwenyewe`,

  // ── Q4a (non-dairy): Farming season ──────────────────────────────────────
  // Why: Season tells us income timing → can we align repayment schedule?
  //      This is for lender benefit, not penalizing the farmer.
  // Node: Updates (:CropActivity {season})
  farmSeason: () =>
    `CON Unapanda msimu gani?\n\n` +
    `1. Masika (Mar-May)\n` +
    `2. Vuli (Oct-Dec)\n` +
    `3. Mwaka mzima`,

  // ── Q5: Community ties — THE most important evidence question ──────────────
  // Why: This is our primary alternative credit signal.
  //      Chama/SACCO/Coop = structured financial behavior, group accountability,
  //      peer monitoring, and often detailed repayment records.
  //      If they answer here, we skip loanHistory entirely.
  // Node: (:CommunityGroup {type: 'chama'|'sacco'|'coop'|'none'})
  // Relationship: (Farmer)-[:MEMBER_OF]->(CommunityGroup)
  communityTies: () =>
    `CON Je, wewe ni mwanachama wa kundi?\n\n` +
    `1. Chama cha wanawake / akiba\n` +
    `2. SACCO\n` +
    `3. Ushirika wa kilimo\n` +
    `4. Sijajiunga na kundi lolote`,

  // ── Q6: Loan history (only asked if no community finance) ─────────────────
  // Why: If no group finance exists, we need at least one formal signal.
  //      Option 4 (repaid_chama) is kept for edge cases where they forgot Q5.
  //      Defaulted is still asked honestly — we do NOT hide it; we contextualize it.
  // Node: (:LoanRecord {outcome})
  loanHistory: () =>
    `CON Umewahi kupata mkopo wowote?\n\n` +
    `1. Ndio, nimelipa yote\n` +
    `2. Ndio, sikulipa yote\n` +
    `3. Mkopo wa chama - nimelipa\n` +
    `4. Hapana, huu ni wa kwanza`,

  // ── Q7: Input access (agricultural spending behavior) ─────────────────────
  // Why: Regular input purchase = M-Pesa outflow pattern = financial planning behavior.
  //      Also signals they are a committed, active farmer (not distressed abandonment).
  //      This is our behavioral economics signal.
  // Node: (:InputPurchase {frequency: 'always'|'sometimes'|'rarely'|'never'})
  inputAccess: () =>
    `CON Unaweza kununua mbegu / mbolea kwa urahisi?\n\n` +
    `1. Ndio, kila msimu\n` +
    `2. Wakati mwingine\n` +
    `3. Ni ngumu kupata\n` +
    `4. Hapana, sisinunui`,

  // ── Confirm screen ────────────────────────────────────────────────────────
  confirm: (answers, sequence) => {
    const lines = buildConfirmLines(answers, sequence);
    return (
      `CON Thibitisha maelezo yako:\n\n` +
      lines.join('\n') +
      `\n\n1. Thibitisha\n2. Anza upya\n0. Toka`
    );
  },

  // ── Processing ────────────────────────────────────────────────────────────
  processing: () =>
    `END Asante! Tunakagua ushahidi wako.\n` +
    `Utapokea SMS ndani ya dakika 2.\n\n` +
    `Piga *384*16051# tena kuona maelezo.`,

  // ── PIN flows (unchanged from v1 — PIN logic is solid) ────────────────────
  setPIN: () =>
    `CON Weka PIN yako (namba 4)\n` +
    `kulinda matokeo yako:\n\n` +
    `Ingiza namba 4:`,

  confirmPIN: () => `CON Ingiza PIN tena kuthibitisha:`,

  pinMismatch: () =>
    `CON PIN hazifanani. Jaribu tena.\nIngiza namba 4:`,

  enterPIN: () => `CON Ingiza PIN yako (namba 4) kuona matokeo:`,

  wrongPIN: () => `CON PIN si sahihi. Jaribu tena.\nIngiza PIN yako:`,

  noResult: () =>
    `END Hatuna matokeo yako bado.\n` +
    `Piga *384*16051# chagua 1 kupata tathmini.`,

  invalid: () => `CON Chaguo si sahihi. Jaribu tena.\n0. Rudi`,

  goodbye: () => `END Asante. Karibu tena!\nShambAI 🌱`,
};

// ═══════════════════════════════════════════════════════════════════════════════
// ANSWER MAPS
// ═══════════════════════════════════════════════════════════════════════════════

const ANSWER_MAPS = {
  consent: { '1': true, '2': false },

  location: {
    '1': 'kiambu',
    '2': 'muranga',
    '3': 'machakos',
    '4': 'nakuru',
    '5': 'nyeri',
    '6': 'other',
  },

  farmAccess: {
    '1': 'owned',
    '2': 'family',    // family land — often as secure as owned for women
    '3': 'leased',
    '4': 'shared',
  },

  leaseLength: {
    '1': 'short',   // < 1 year — lower stability
    '2': 'medium',  // 1-3 years — moderate
    '3': 'long',    // 3+ years — near-ownership stability
  },

  cropType: {
    '1': 'crops',     // maize/beans
    '2': 'dairy',     // livestock — triggers adaptive branch
    '3': 'horticulture',
    '4': 'mixed',
  },

  herdSize: {
    '1': 'small',   // 1-2 animals
    '2': 'medium',  // 3-5
    '3': 'large',   // 6-10
    '4': 'xlarge',  // 10+
  },

  milkCooperative: {
    '1': 'monthly',    // regular structured payments = strong evidence
    '2': 'occasional',
    '3': 'none',
  },

  farmSeason: {
    '1': 'long_rains',
    '2': 'short_rains',
    '3': 'year_round',
  },

  communityTies: {
    '1': 'chama',  // women's savings group — strongest alternative signal
    '2': 'sacco',
    '3': 'coop',   // agricultural cooperative
    '4': 'none',
  },

  loanHistory: {
    '1': 'repaid_full',
    '2': 'defaulted',
    '3': 'repaid_chama',
    '4': 'no_prior',
  },

  inputAccess: {
    '1': 'always',     // every season — consistent purchasing = financial planning
    '2': 'sometimes',
    '3': 'rarely',     // structural barrier — we note this as systemic, not personal
    '4': 'never',
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIRM SCREEN LABEL BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIRM_LABELS = {
  consent:         v => v === true ? 'M-Pesa: Ndio' : 'M-Pesa: Hapana',
  location:        v => `Kaunti: ${v}`,
  farmAccess:      v => ({ owned: 'Shamba langu', family: 'Familia', leased: 'Napangisha', shared: 'Kushiriki' }[v] || v),
  leaseLength:     v => ({ short: 'Panga: <1yr', medium: 'Panga: 1-3yr', long: 'Panga: 3yr+' }[v] || v),
  cropType:        v => ({ crops: 'Mazao', dairy: 'Ng\'ombe', horticulture: 'Mboga', mixed: 'Mchanganyiko' }[v] || v),
  herdSize:        v => `Ng'ombe: ${v}`,
  milkCooperative: v => ({ monthly: 'Ushirika: kila mwezi', occasional: 'Ushirika: wakati mwingine', none: 'Ushirika: hapana' }[v] || v),
  farmSeason:      v => ({ long_rains: 'Masika', short_rains: 'Vuli', year_round: 'Mwaka mzima' }[v] || v),
  communityTies:   v => ({ chama: 'Chama', sacco: 'SACCO', coop: 'Ushirika', none: 'Hakuna kundi' }[v] || v),
  loanHistory:     v => ({ repaid_full: 'Mkopo: Nimelipa', defaulted: 'Mkopo: Sikulipa', repaid_chama: 'Chama: Nimelipa', no_prior: 'Mkopo: wa kwanza' }[v] || v),
  inputAccess:     v => ({ always: 'Mbegu: kila msimu', sometimes: 'Mbegu: wakati mwingine', rarely: 'Mbegu: ngumu', never: 'Mbegu: sisinunui' }[v] || v),
};

function buildConfirmLines(answers, sequence) {
  return sequence.map(key => {
    const val = answers[key];
    const labelFn = CONFIRM_LABELS[key];
    return labelFn ? labelFn(val) : `${key}: ${val}`;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN ROUTER
// ═══════════════════════════════════════════════════════════════════════════════

function screenForKey(key) {
  const fn = S[key];
  return fn ? fn() : S.invalid();
}

function mapAnswer(key, rawValue) {
  const map = ANSWER_MAPS[key];
  if (!map) return rawValue;
  return map[rawValue] !== undefined ? map[rawValue] : rawValue;
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEO4J EVIDENCE GRAPH BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Transforms collected answers into a structured evidence graph payload
 * for Neo4j. Each node and relationship is explicitly tagged with its
 * evidence role so the scoring engine can explain its reasoning.
 *
 * Evidence roles:
 *   - TENURE_SIGNAL:      land stability (replaces collateral check)
 *   - INCOME_SIGNAL:      crop/livestock info (replaces salary slip)
 *   - NETWORK_SIGNAL:     community ties (replaces guarantor requirement)
 *   - BEHAVIOR_SIGNAL:    input purchases + M-Pesa (replaces bank history)
 *   - REPAYMENT_SIGNAL:   loan/chama history (direct creditworthiness)
 */
function buildEvidenceGraphPayload(answers, phoneHash, sequence) {
  const nodes = [];
  const relationships = [];

  // Core farmer node
  nodes.push({
    label: 'Farmer',
    props: { phoneHash, location: answers.location, scoredAt: new Date().toISOString() },
  });

  // M-Pesa consent node
  nodes.push({
    label: 'MPesaConsent',
    props: { granted: answers.consent, evidenceRole: 'BEHAVIOR_SIGNAL' },
  });
  relationships.push({ from: 'Farmer', to: 'MPesaConsent', type: 'GRANTED_CONSENT' });

  // Farm tenure node
  nodes.push({
    label: 'FarmTenure',
    props: {
      type: answers.farmAccess,
      leaseLength: answers.leaseLength || null,
      evidenceRole: 'TENURE_SIGNAL',
    },
  });
  relationships.push({ from: 'Farmer', to: 'FarmTenure', type: 'HAS_TENURE' });

  // Crop / livestock activity node
  const cropProps = {
    cropType: answers.cropType,
    evidenceRole: 'INCOME_SIGNAL',
  };
  if (answers.cropType === 'dairy') {
    cropProps.herdSize = answers.herdSize;
    cropProps.milkCooperative = answers.milkCooperative;
  } else {
    cropProps.season = answers.farmSeason;
  }
  nodes.push({ label: 'CropActivity', props: cropProps });
  relationships.push({ from: 'Farmer', to: 'CropActivity', type: 'GROWS' });

  // If dairy and milk cooperative — create cooperative node and link
  if (answers.cropType === 'dairy' && answers.milkCooperative === 'monthly') {
    nodes.push({
      label: 'CommunityGroup',
      props: { type: 'milk_coop', paymentFrequency: 'monthly', evidenceRole: 'NETWORK_SIGNAL' },
    });
    relationships.push({ from: 'Farmer', to: 'CommunityGroup', type: 'MEMBER_OF' });
    relationships.push({ from: 'CommunityGroup', to: 'CropActivity', type: 'HAS_PAYMENT_RECORD' });
  }

  // Community group node
  if (answers.communityTies && answers.communityTies !== 'none') {
    nodes.push({
      label: 'CommunityGroup',
      props: { type: answers.communityTies, evidenceRole: 'NETWORK_SIGNAL' },
    });
    relationships.push({ from: 'Farmer', to: 'CommunityGroup', type: 'MEMBER_OF' });
  }

  // Loan history node (only present if question was asked)
  if (sequence.includes('loanHistory') && answers.loanHistory) {
    nodes.push({
      label: 'LoanRecord',
      props: { outcome: answers.loanHistory, evidenceRole: 'REPAYMENT_SIGNAL' },
    });
    relationships.push({ from: 'Farmer', to: 'LoanRecord', type: 'HAS_LOAN_RECORD' });
  }

  // Input purchase node
  if (answers.inputAccess) {
    nodes.push({
      label: 'InputPurchase',
      props: { frequency: answers.inputAccess, evidenceRole: 'BEHAVIOR_SIGNAL' },
    });
    relationships.push({ from: 'Farmer', to: 'InputPurchase', type: 'PURCHASED_INPUTS' });
  }

  return { nodes, relationships };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleUSSD({ sessionId, phoneNumber, text, networkCode }) {
  const parts = text === '' ? [] : text.split('*');
  const mainChoice = parts[0];

  // ── Main menu ──────────────────────────────────────────────────────────────
  if (parts.length === 0) return S.main();

  if (mainChoice === '0') {
    await deleteSession(sessionId);
    return S.goodbye();
  }

  // ══ FLOW A: New assessment ════════════════════════════════════════════════
  if (mainChoice === '1') {
    let session = await getSession(sessionId);

    // Initialize session on first entry
    if (!session || session.state !== 'assess') {
      session = { state: 'assess', answers: {} };
      await saveSession(sessionId, session);
    }

    const answers = session.answers;

    // Compute adaptive sequence based on current answers
    const sequence = computeSequence(answers);
    const answeredKeys = sequence.filter(k => answers.hasOwnProperty(k));
    const nextKey = sequence[answeredKeys.length];

    // ── Show first question ──────────────────────────────────────────────────
    if (parts.length === 1 && answeredKeys.length === 0) {
      return screenForKey(nextKey);
    }

    // ── Process incoming answer ──────────────────────────────────────────────
    // parts = ['1', ans1, ans2, ...]
    // The answer for the n-th question is at parts[n+1]
    const answerIndex = answeredKeys.length + 1;

    if (parts.length <= answerIndex) {
      // Waiting for input — redisplay the current question
      return screenForKey(nextKey);
    }

    const rawValue = parts[answerIndex];
    const mapped = mapAnswer(nextKey, rawValue);

    if (mapped === undefined || mapped === rawValue && !Object.keys(ANSWER_MAPS[nextKey] || {}).length) {
      // Invalid choice — but don't lose session
      return S.invalid();
    }

    // Validate the answer is a known value
    const validValues = ANSWER_MAPS[nextKey] ? Object.values(ANSWER_MAPS[nextKey]) : null;
    if (validValues && !validValues.includes(mapped)) {
      return S.invalid();
    }

    // Save the answer
    answers[nextKey] = mapped;
    await saveSession(sessionId, session);

    // ── Recompute sequence after saving (answers may change branch) ──────────
    const newSequence = computeSequence(answers);
    const newAnsweredKeys = newSequence.filter(k => answers.hasOwnProperty(k));

    // ── All questions answered → show confirm ────────────────────────────────
    if (newAnsweredKeys.length === newSequence.length) {
      return S.confirm(answers, newSequence);
    }

    // ── More questions remaining ─────────────────────────────────────────────
    const nextNextKey = newSequence[newAnsweredKeys.length];
    return screenForKey(nextNextKey);
  }

  // ── Handle confirm screen actions (after all questions answered) ────────────
  if (mainChoice === '1') {
    // This branch handles the confirm screen choices
    // (the confirm check above returns early so this handles post-confirm)
  }

  // Detect if we are in the confirm/post-confirm state for Flow A
  // We check: mainChoice === '1' AND all questions answered
  {
    const session = await getSession(sessionId);
    if (session?.state === 'assess') {
      const answers = session.answers;
      const sequence = computeSequence(answers);
      const answeredKeys = sequence.filter(k => answers.hasOwnProperty(k));

      if (answeredKeys.length === sequence.length) {
        // We are at the confirm screen
        const lastPart = parts[parts.length - 1];

        if (lastPart === '2') {
          // Start over
          await deleteSession(sessionId);
          return S.main();
        }

        if (lastPart === '0') {
          await deleteSession(sessionId);
          return S.goodbye();
        }

        if (lastPart !== '1') {
          return S.invalid();
        }

        // ── User confirmed — run evidence discovery + risk assessment ─────────
        const phoneHash = hashPhone(phoneNumber);
        const graphPayload = buildEvidenceGraphPayload(answers, phoneHash, sequence);

        // Write farmer node + full evidence graph to Neo4j (non-blocking)
        writeFarmerNode({
          phoneHash,
          location: answers.location,
          crop: answers.cropType,
          farmAccess: answers.farmAccess,
        }).catch(err => console.warn('Neo4j farmer node write failed:', err.message));

        writeEvidenceGraph(graphPayload)
          .catch(err => console.warn('Neo4j evidence graph write failed:', err.message));

        // Build application data for risk engine
        const applicationData = {
          phone: phoneNumber,
          phoneHash,
          consent: answers.consent,
          location: answers.location,
          farmAccess: answers.farmAccess,
          leaseLength: answers.leaseLength || null,
          cropType: answers.cropType,
          herdSize: answers.herdSize || null,
          milkCooperative: answers.milkCooperative || null,
          farmSeason: answers.farmSeason || null,
          communityTies: answers.communityTies,
          loanHistory: answers.loanHistory || null, // may be null if skipped
          inputAccess: answers.inputAccess,
          questionsAnswered: sequence.length,
          adaptiveBranches: {
            wasDairy: answers.cropType === 'dairy',
            hasGroupFinance: ['chama', 'sacco', 'coop'].includes(answers.communityTies),
            wasLeased: answers.farmAccess === 'leased',
            loanHistorySkipped: !sequence.includes('loanHistory'),
          },
          evidenceGraph: graphPayload,
        };

        // Run risk assessment (fetches M-Pesa, weather, Neo4j graph queries)
        const result = await initiateRiskAssessment(applicationData, phoneHash);

        // Persist farmer record
        const existing = await getFarmerRecord(phoneNumber);
        await saveFarmerRecord(phoneNumber, {
          lastScore: result,
          lastTier: result.tier,
          lastScoredAt: result.scoredAt,
          assessmentCount: (existing?.assessmentCount || 0) + 1,
          pinSet: existing?.pinSet || false,
          pin: existing?.pin || null,
          lastEvidence: result.evidenceProfile || null,
          lastSequence: sequence,
          adaptiveBranches: applicationData.adaptiveBranches,
        });

        // Send SMS (non-blocking)
        const smsText = buildSMS(result);
        console.log('📱 SMS CONTENT:', smsText);
        sendSMS(phoneNumber, smsText).catch(err =>
          console.error('SMS send failed:', err.message)
        );

        await deleteSession(sessionId);
        return S.processing();
      }
    }
  }

  // ══ FLOW B: View my result (PIN-gated) ═══════════════════════════════════
  if (mainChoice === '2') {
    const farmerRecord = await getFarmerRecord(phoneNumber);
    if (!farmerRecord?.lastScore) return S.noResult();

    const fd = parts.length - 1;

    // Sub-flow B1: No PIN yet → create one first
    if (!farmerRecord.pinSet) {
      if (fd === 0) return S.setPIN();
      if (fd === 1) {
        if (!/^\d{4}$/.test(parts[1])) {
          return `CON PIN lazima iwe namba 4.\nJaribu tena:`;
        }
        const existingSession = await getSession(sessionId);
        await saveSession(sessionId, { ...existingSession, candidatePIN: parts[1] });
        return S.confirmPIN();
      }
      if (fd === 2) {
        const sess = await getSession(sessionId);
        if (!sess || parts[2].trim() !== sess.candidatePIN.trim()) {
          await deleteSession(sessionId);
          return S.pinMismatch();
        }
        await saveFarmerRecord(phoneNumber, {
          ...farmerRecord,
          pin: parts[2],
          pinSet: true,
        });
        await deleteSession(sessionId);
        const detail = buildUSSDDetail(farmerRecord.lastScore);
        return `CON ${detail}\n\n0. Toka`;
      }
    }

    // Sub-flow B2: Has PIN → verify then show explainable evidence summary
    if (fd === 0) return S.enterPIN();
    if (fd === 1) {
      if (parts[1] !== farmerRecord.pin) return S.wrongPIN();
      const detail = buildUSSDDetail(farmerRecord.lastScore);
      await saveSession(sessionId, { detailShown: true });
      return `CON ${detail}\n\n1. Elimu ya malipo\n0. Toka`;
    }
    if (fd === 2 && parts[2] === '1') {
      return buildRepaymentLink(farmerRecord.lastTier);
    }
    if (fd === 2 && parts[2] === '0') {
      await deleteSession(sessionId);
      return S.goodbye();
    }
    return S.invalid();
  }

  // ══ FLOW C: Repayment education ══════════════════════════════════════════
  if (mainChoice === '3') {
    const farmerRecord = await getFarmerRecord(phoneNumber);
    const tier = farmerRecord?.lastTier || 4;
    return buildRepaymentLink(tier);
  }

  return S.invalid();
}

module.exports = { handleUSSD, computeSequence, buildEvidenceGraphPayload };