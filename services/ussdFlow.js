/**
 * ussdFlow.js — USSD session state machine (kenyan-street-swa version)
 *
 * Africa's Talking sends the full accumulated input on every keypress.
 * `text` looks like: "" → "1" → "1*2" → "1*2*3" etc.
 *
 * We split on '*' and route based on depth + first choice.
 *
 * Flow A — New assessment (text starts with "1"):
 *   1 → crop → productionSize → coop → loan → group → mpesa → gender → confirm → score
 *
 * Flow B — View my result (text starts with "2"):
 *   2 → enter PIN → show detail OR set PIN if first time
 *
 * Flow C — Understand repayment (text starts with "3"):
 *   3 → repayment connection message
 *
 * Privacy gate:
 *   The SMS is safe to read by anyone (no sensitive language).
 *   The full USSD detail requires a 4-digit PIN set by the farmer.
 *   If she hasn't set a PIN yet, flow B asks her to create one first.
 *
 * Evidence architecture:
 *   Scoring is done once in scoreWithNetwork() which calls Neo4j internally.
 *   The full evidenceProfile is stored in the farmer record for MIS/reporting.
 *   No duplicate Neo4j calls.
 */

const { getSession, saveSession, deleteSession, getFarmerRecord, saveFarmerRecord } = require('../db/sessionStore');
const { score, scoreWithNetwork, tierMeta } = require('./scorer');
const { buildSMS, buildUSSDDetail, buildRepaymentLink } = require('./explainer');
const { writeFarmerNode } = require('../db/neo4j');
const { hashPhone } = require('../db/sessionStore');
const { sendSMS } = require('./smsService');

// ── Screen builders (Kenyan-market Swahili) ─────────────────────────────────

const S = {
  main: () =>
    `CON Karibu FarmCredit 🌱\n` +
    `Welcome to FarmCredit\n\n` +
    `1. Pima mkopo wako\n` +
    `2. Matokeo yangu\n` +
    `3. Elimu ya malipo\n` +
    `0. Toka`,

  crop: () =>
    `CON Unalima nini hasa?\n\n` +
    `1. Mahindi\n` +
    `2. Maharagwe\n` +
    `3. Ng'ombe/Maziwa\n` +
    `4. Mboga/Matunda\n` +
    `5. Mchanganyiko`,

  productionSize: () =>
    `CON Ukubwa wa uzalishaji wako?\n\n` +
    `1. Mdogo (kaya tu)\n` +
    `2. Wastani (kuuza sehemu)\n` +
    `3. Mkubwa (biashara)`,

  coop: () =>
    `CON Uko kwenye ushirika wa kilimo?\n\n` +
    `1. Ndio, miaka 2+ (active)\n` +
    `2. Ndio, chini ya miaka 2\n` +
    `3. Ndio, lakini sio active\n` +
    `4. Hapana`,

  loan: () =>
    `CON Umewahi kupata mkopo?\n\n` +
    `1. Ndio, nimelipa yote\n` +
    `2. Ndio, nimelipa sehemu\n` +
    `3. Ndio, sikulipa\n` +
    `4. Mkopo wa chama nililipa\n` +
    `5. Hapana, huu ni wa kwanza`,

  group: () =>
    `CON Uko kwenye chama cha akiba?\n\n` +
    `1. Ndio, nachangia kila wakati\n` +
    `2. Ndio, wakati mwingine\n` +
    `3. Hapana`,

  mpesa: () =>
    `CON Unatumia M-Pesa aje?\n\n` +
    `1. Kila siku\n` +
    `2. Kila wiki\n` +
    `3. Kila mwezi\n` +
    `4. Mara chache`,

  gender: () =>
    `CON Swali la mwisho: Jinsia?\n\n` +
    `1. Mwanamke\n` +
    `2. Mwanaume\n` +
    `3. Sitaki kusema`,

  confirm: (answers) => {
    return `CON Hakikisha:\n\n` +
      `Zao: ${cropLabel(answers.crop)}\n` +
      `Uzalishaji: ${productionSizeLabel(answers.productionSize)}\n` +
      `Ushirika: ${coopLabel(answers.coop)}\n` +
      `Mkopo: ${loanLabel(answers.loan)}\n` +
      `Chama: ${groupLabel(answers.group)}\n` +
      `M-Pesa: ${mpesaLabel(answers.mpesa)}\n` +
      `Jinsia: ${genderLabel(answers.gender)}\n\n` +
      `1. Hakikisha, pata matokeo\n` +
      `2. Anza upya\n` +
      `0. Toka`;
  },

  processing: () =>
    `END Asante! Tunakutumia matokeo kwa SMS.\n` +
    `Utapokea ujumbe ndani ya dakika 1.\n\n` +
    `Piga *384# tena kwa maelezo zaidi.`,

  setPIN: () =>
    `CON Weka PIN yako ya siri (namba 4)\n` +
    `ili kulinda matokeo yako:\n\n` +
    `Ingiza namba 4:`,

  confirmPIN: () =>
    `CON Ingiza PIN tena kuthibitisha:`,

  pinMismatch: () =>
    `CON PIN hazifanani. Jaribu tena.\n` +
    `Ingiza namba 4:`,

  enterPIN: () =>
    `CON Ingiza PIN yako (namba 4) kuona matokeo:`,

  wrongPIN: () =>
    `CON PIN si sahihi. Jaribu tena.\n` +
    `Ingiza PIN yako:`,

  noResult: () =>
    `END Hatuna matokeo yako bado.\n` +
    `Piga *384# chagua 1 kupima mkopo.`,

  invalid: () =>
    `CON Chaguo si sahihi. Jaribu tena.\n` +
    `0. Rudi`,

  goodbye: () =>
    `END Asante. Karibu tena!\nFarmCredit 🌱`,
};

// ── Label helpers (confirm screen) ───────────────────────────────────────────

const cropLabel = (c) => ({
  maize: 'Mahindi',
  beans: 'Maharagwe',
  dairy: 'Maziwa',
  horticulture: 'Mboga',
  mixed: 'Mchanganyiko'
}[c] || '?');

const productionSizeLabel = (p) => ({
  small: 'Mdogo',
  medium: 'Wastani',
  large: 'Mkubwa'
}[p] || '?');

const coopLabel = (c) => ({
  active_over2yr: 'Miaka 2+',
  active_under2yr: '<Miaka 2',
  inactive: 'Sio active',
  none: 'Hapana'
}[c] || '?');

const loanLabel = (l) => ({
  'repaid_full': 'Nililipa yote',
  'repaid_partial': 'Nililipa sehemu',
  'defaulted': 'Sikulipa',
  'repaid_chama': 'Mkopo wa chama',
  'no_prior': 'Mkopo wa kwanza'
}[l] || '?');

const groupLabel = (g) => ({
  'active_saving': 'Nachangia kila wakati',
  'occasional': 'Wakati mwingine',
  'none': 'Hapana'
}[g] || '?');

const mpesaLabel = (m) => ({
  'daily': 'Kila siku',
  'weekly': 'Kila wiki',
  'monthly': 'Kila mwezi',
  'rarely': 'Mara chache'
}[m] || '?');

const genderLabel = (g) => ({
  'female': 'Mwanamke',
  'male': 'Mwanaume',
  'unspecified': 'Sitaki kusema'
}[g] || '?');

// ── Answer maps → scorer keys ─────────────────────────────────────────────────

const CROP_MAP     = { '1':'maize','2':'beans','3':'dairy','4':'horticulture','5':'mixed' };
const LAND_MAP     = { '1':'under1','2':'one_three','3':'three_ten','4':'over10' };
const HERD_MAP     = { '1':'1-2','2':'3-5','3':'6-10','4':'over10' };
const COOP_MAP     = { '1':'active_over2yr','2':'active_under2yr','3':'inactive','4':'none' };
const LOAN_MAP     = { '1':'repaid_full','2':'repaid_partial','3':'defaulted','4':'repaid_chama','5':'no_prior' };
const GROUP_MAP    = { '1':'active_saving','2':'occasional','3':'none' };
const MPESA_MAP    = { '1':'daily','2':'weekly','3':'monthly','4':'rarely' };
const GENDER_MAP   = { '1':'female','2':'male','3':'unspecified' };
const COMBINED_MAP = { '1':'small_farm_few','2':'medium_farm_moderate','3':'large_farm_many','4':'very_large_farm_many' };

// ── Question sequences per crop ──────────────────────────────────────────────

const SEQUENCES = {
  default: [
    'productionSize',
    'coop',
    'loan',
    'group',
    'mpesa',
    'gender'
  ]
};

// ── Next question screen based on key ────────────────────────────────────────

function screenForKey(key) {
  const screens = {
    productionSize: S.productionSize,
    coop: S.coop,
    loan: S.loan,
    group: S.group,
    mpesa: S.mpesa,
    gender: S.gender
  };
  
  return screens[key] ? screens[key]() : S.invalid();
}

// ── Map answer value to scorer key ──────────────────────────────────────────

function mapAnswer(key, value) {
  const maps = {
    land:     LAND_MAP,
    coop:     COOP_MAP,
    herd:     HERD_MAP,
    milkcoop: COOP_MAP,
    combined: COMBINED_MAP,
    loan:     LOAN_MAP,
    group:    GROUP_MAP,
    mpesa:    MPESA_MAP,
    gender:   GENDER_MAP,
    crop:     CROP_MAP,
  };
  return (maps[key] && maps[key][value]) || value;
}

// ── Main handler ─────────────────────────────────────────────────────────────

async function handleUSSD({ sessionId, phoneNumber, text, networkCode }) {
  const parts = text === '' ? [] : text.split('*');
  const mainChoice = parts[0];

  // Main menu
  if (parts.length === 0) return S.main();

  // Exit from top-level only
  if (mainChoice === '0') {
    await deleteSession(sessionId);
    return S.goodbye();
  }

  // ══ FLOW A: New assessment ════════════════════════════════════════════════
  if (mainChoice === '1') {
    let session = await getSession(sessionId);
    if (!session || session.state !== 'assess') {
      session = { state: 'assess', answers: {} };
      await saveSession(sessionId, session);
    }

    const answers = session.answers;

    // ── 1st step: crop question ──────────────────────────────────────────────
    if (!answers.crop) {
  if (parts.length < 2) return S.crop();
  const cropVal = parts[1];
  if (!CROP_MAP[cropVal]) return S.invalid();
  answers.crop = CROP_MAP[cropVal];
  await saveSession(sessionId, session);
  const seq = SEQUENCES[answers.crop] || SEQUENCES['default'];  // ← fix
  return screenForKey(seq[0]);
}

    // ── Collect answers using the crop‑specific sequence ─────────────────────
    const seq = SEQUENCES[answers.crop] || SEQUENCES['default'];
    const storedSeqKeys = seq.filter(key => answers.hasOwnProperty(key));

    if (storedSeqKeys.length === seq.length) {
      const lastPart = parts[parts.length - 1];
      
      if (lastPart === '2') {
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

      // ── Score the farmer ───────────────────────────────────────────────────
      const scorerInput = { crop: answers.crop };
      for (const key of seq) {
        scorerInput[key] = answers[key];
      }
      scorerInput.gender = answers.gender;

      const phoneHash = hashPhone(phoneNumber);

      // Write farmer node to Neo4j (fire & forget — must happen before scoring
      // so that if farmer is already in graph their node is current)
      writeFarmerNode({
        phoneHash,
        tier:      null,           // will be updated after scoring
        crop:      answers.crop,
        land:      answers.land   || null,
        herd:      answers.herd   || null,
        gender:    answers.gender,
        coopName:  answers.coop !== 'none'
          ? 'Self-reported coop'
          : (answers.milkcoop && answers.milkcoop !== 'none' ? 'Milk coop' : null),
        hadLoan:   answers.loan !== 'no_prior',
        repaid:    answers.loan === 'repaid_full' || answers.loan === 'repaid_chama',
      }).catch(err => console.warn('Neo4j write failed:', err.message));

      // scoreWithNetwork runs base rules + Neo4j evidence in one call.
      // No duplicate Neo4j query here.
      const result = await scoreWithNetwork(scorerInput, phoneHash);

      // Save farmer record — include evidenceProfile for MIS/reporting
      const existing = await getFarmerRecord(phoneNumber);
      await saveFarmerRecord(phoneNumber, {
        lastScore:        result,
        lastTier:         result.tier,
        lastScoredAt:     result.scoredAt,
        assessmentCount:  (existing?.assessmentCount || 0) + 1,
        pinSet:           existing?.pinSet || false,
        pin:              existing?.pin    || null,
        // Store evidence separately at top level for MIS queries
        lastEvidence:     result.evidenceProfile || null,
      });

      // Send SMS asynchronously
// Send SMS asynchronously
    const smsText = buildSMS(result);
    console.log('📱 SMS CONTENT:', smsText);  // ← add here
    sendSMS(phoneNumber, smsText).catch(err =>
      console.error('SMS send failed:', err.message)
    );

      await deleteSession(sessionId);
      return S.processing();
    }

    // ── Still collecting answers ──────────────────────────────────────────────
    const nextKey = seq[storedSeqKeys.length];

// parts: ['1', cropAnswer, seqAnswer1, seqAnswer2, ...]
// parts[0] = '1' (flow), parts[1] = crop, parts[2+] = sequence answers
// So sequence answers start at index 2
const seqAnswersInParts = parts.length - 2; // subtract flow choice + crop

if (seqAnswersInParts <= storedSeqKeys.length) {
  // Haven't received the answer for nextKey yet — show the question
  return screenForKey(nextKey);
}

const answerValue = parts[storedSeqKeys.length + 2]; // precise index
    const map = {
      land: LAND_MAP, coop: COOP_MAP, herd: HERD_MAP, milkcoop: COOP_MAP,
      combined: COMBINED_MAP, loan: LOAN_MAP, group: GROUP_MAP,
      mpesa: MPESA_MAP, gender: GENDER_MAP,
    };
    const mapped = map[nextKey] ? map[nextKey][answerValue] : undefined;
    if (mapped === undefined) return S.invalid();
    answers[nextKey] = mapped;
    await saveSession(sessionId, session);

    const newStoredLen = seq.filter(k => answers.hasOwnProperty(k)).length;
    
    if (newStoredLen === seq.length) {
      return S.confirm(answers);
    }
    return screenForKey(seq[newStoredLen]);
  }

  // ══ FLOW B: View my result (PIN-gated) ═══════════════════════════════════
  if (mainChoice === '2') {
    const farmerRecord = await getFarmerRecord(phoneNumber);
    if (!farmerRecord?.lastScore) return S.noResult();

    const fd = parts.length - 1;

    // Sub-flow B1: farmer has no PIN yet → set one first
    if (!farmerRecord.pinSet) {
      if (fd === 0) return S.setPIN();
      if (fd === 1) {
        if (!/^\d{4}$/.test(parts[1])) {
          return `CON PIN lazima iwe namba 4.\nJaribu tena:`;
        }
        await saveSession(sessionId, { candidatePIN: parts[1] });
        return S.confirmPIN();
      }
      if (fd === 2) {
        const sess = await getSession(sessionId);
        if (parts[2] !== sess?.candidatePIN) {
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

    // Sub-flow B2: farmer has PIN → verify then show detail
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
    
    // Handle other options in detail view
    if (fd === 2 && parts[2] === '0') {
      await deleteSession(sessionId);
      return S.goodbye();
    }
  }

  // ══ FLOW C: Repayment & credit education ══════════════════════════════════
  if (mainChoice === '3') {
    const farmerRecord = await getFarmerRecord(phoneNumber);
    const tier = farmerRecord?.lastTier || 4;
    return buildRepaymentLink(tier);
  }

  return S.invalid();
}

module.exports = { handleUSSD };