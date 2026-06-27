/**
 * explainer.js
 *
 * This is the core intellectual work of the system.
 *
 * Takes the internal score object and produces TWO outputs:
 *
 *  1. SMS (≤182 chars) — sent immediately after scoring
 *     - Shows tier name (not a number score)
 *     - One concrete next action she can realistically take
 *     - The outcome of that action (what it unlocks)
 *     - A return date ("dial again in X weeks")
 *     - NEVER uses "rejected", "denied", "failed", "risk"
 *     - Safe if read by someone else — no sensitive decision language
 *
 *  2. USSD detail — shown when she dials back and enters her PIN
 *     - Slightly more detail: tier, two actions, timeline
 *     - Includes graph evidence note when Neo4j found relationships
 *     - Still no score number, no factor weights
 *     - Framed as a path forward, not a judgment
 *
 * Language philosophy:
 *  - Swahili first, English in parentheses
 *  - Active voice: "Lipa chama" not "Chama haijalipwa"
 *  - Concrete outcome: "mkopo wa KES 5,000" not "alama yako itaongezeka"
 *  - Agency: "unaweza" (you can) not "lazima" (you must)
 *  - Time-bound: always give a return date so she knows when to act
 */

const { GAPS, tierMeta } = require('./scorer');

// ── Action templates ──────────────────────────────────────────────────────────
// Each gap maps to one primary action.

const ACTIONS = {
  [GAPS.NO_LOAN_HISTORY]: {
    action_sw:  'Omba mkopo mdogo wa KES 2,000 sasa na ulipe kwa wakati',
    action_en:  'Take a KES 2,000 starter loan and repay on time',
    outcome_sw: 'mkopo mkubwa zaidi msimu ujao',
    outcome_en: 'a larger loan next season',
    weeks: 12,
  },
  [GAPS.DEFAULTED]: {
    action_sw:  'Anza kulipa deni lako la zamani, hata kidogo kwa wakati',
    action_en:  'Start repaying your previous loan, even in small amounts on time',
    outcome_sw: 'nafasi ya mkopo mpya baada ya malipo 3',
    outcome_en: 'a new loan opportunity after 3 payments',
    weeks: 16,
  },
  [GAPS.NO_COOP]: {
    action_sw:  'Jiunge na ushirika au chama cha akiba karibu nawe',
    action_en:  'Join a cooperative or savings group near you',
    outcome_sw: 'ongezeko kubwa katika kiwango chako',
    outcome_en: 'a significant increase in your tier',
    weeks: 12,
  },
  [GAPS.INACTIVE_COOP]: {
    action_sw:  'Rejesha ushiriki wako amilifu katika ushirika',
    action_en:  'Reactivate your cooperative membership',
    outcome_sw: 'kiwango cha juu zaidi',
    outcome_en: 'a higher tier',
    weeks: 8,
  },
  [GAPS.NO_GROUP]: {
    action_sw:  'Jiunge na chama cha akiba na uchangie kwa miezi 3',
    action_en:  'Join a savings group (chama) and contribute for 3 months',
    outcome_sw: 'ongezeko la kiwango chako',
    outcome_en: 'an improved tier',
    weeks: 12,
  },
  [GAPS.LOW_MPESA]: {
    action_sw:  'Tumia M-Pesa kupokea na kutuma pesa kila wiki',
    action_en:  'Use M-Pesa to send and receive money every week',
    outcome_sw: 'historia nzuri ya miamala',
    outcome_en: 'a stronger transaction history',
    weeks: 8,
  },
  [GAPS.SMALL_FARM]: {
    action_sw:  'Fikiria kukodisha ardhi zaidi msimu ujao',
    action_en:  'Consider leasing additional land next season',
    outcome_sw: 'kipato kikubwa zaidi na kiwango cha juu',
    outcome_en: 'higher income and a better tier',
    weeks: 16,
  },
};

// Fallback when no gap is identified (already tier 1, or gaps unclear)
const FALLBACK_ACTION = {
  action_sw:  'Endelea kulipa mkopo wako kwa wakati',
  action_en:  'Keep repaying your loans on time',
  outcome_sw: 'kiwango chako kubaki juu',
  outcome_en: 'your tier to stay strong',
  weeks: 8,
};

// ── Tier opening lines ────────────────────────────────────────────────────────

const TIER_LINES = {
  1: {
    sw: 'Hongera! Umefikia Kiwango cha Kwanza.',
    en: 'Congratulations! You have reached Tier 1.',
  },
  2: {
    sw: 'Umefanikiwa kufikia Kiwango cha Pili.',
    en: 'You have reached Tier 2.',
  },
  3: {
    sw: 'Uko kwenye Kiwango cha Tatu — karibu zaidi.',
    en: 'You are at Tier 3 — getting closer.',
  },
  4: {
    sw: 'Uko kwenye Kiwango cha Nne — safari inaanza hapa.',
    en: 'You are at Tier 4 — the journey starts here.',
  },
};

// ── Evidence note builder ─────────────────────────────────────────────────────

/**
 * Builds a short plain-text note describing what Neo4j found.
 * Used in buildUSSDDetail() when evidenceProfile is present.
 *
 * This is the "why Neo4j" moment made visible to the farmer.
 * Language: reassuring, not technical. She sees evidence that
 * her community was considered, not that an algorithm ran.
 *
 * Returns null if no evidence was found (don't show the section at all).
 */
function buildEvidenceNote(evidenceProfile) {
  if (!evidenceProfile || !evidenceProfile.found) return null;

  const lines = [];

  if (evidenceProfile.coopName && evidenceProfile.coopRepayRate !== null) {
    const rate = evidenceProfile.coopRepayRate;
    if (rate >= 85) {
      lines.push(
        `Ushirika wako (${evidenceProfile.coopName}) una historia nzuri.`
      );
      lines.push(`(Your cooperative has a strong repayment record.)`);
    } else if (rate >= 60) {
      lines.push(`Ushirika wako (${evidenceProfile.coopName}) uliangaliwa.`);
      lines.push(`(Your cooperative network was reviewed.)`);
    }
  }

  if (evidenceProfile.goodNeighbors >= 2) {
    lines.push(
      `Wanachama ${evidenceProfile.goodNeighbors} wa ushirika wako wana rekodi nzuri.`
    );
    lines.push(`(${evidenceProfile.goodNeighbors} members in your network have clean records.)`);
  }

  if (evidenceProfile.secondDegreeLinks >= 3) {
    lines.push(`Mtandao wako wa pili pia ulichangia tathmini yako.`);
    lines.push(`(Wider community connections also supported your assessment.)`);
  }

  if (evidenceProfile.guarantors >= 1) {
    lines.push(`Mdhamini wako wa vikundi alionekana.`);
    lines.push(`(Your peer guarantor's record was counted.)`);
  }

  if (lines.length === 0) return null;

  return lines.join('\n');
}

// ── SMS builder (≤182 chars) ──────────────────────────────────────────────────

function buildSMS(scoreResult) {
  const { tier, gaps } = scoreResult;
  const meta   = tierMeta(tier);
  const topGap = gaps?.[0];
  const action =
  topGap && ACTIONS[topGap.gap]
    ? ACTIONS[topGap.gap]
    : FALLBACK_ACTION;
  const weeks  = action.weeks;

  // Tier 1 — approved, no next-step needed
  if (tier === 1) {
    const msg =
      `FarmCredit: ${TIER_LINES[1].sw} ` +
      `Mkopo wa hadi ${meta.limit} unakusubiri. ` +
      `Ofisi itawasiliana nawe. ` +
      `Maswali? Piga *384#.`;
    return truncate(msg, 182);
  }

  // Tiers 2–4 — one action, one outcome, one return date
  const msg =
    `FarmCredit: ${TIER_LINES[tier].sw} ` +
    `Hatua moja: ${action.action_sw}. ` +
    `Hii itafungua ${action.outcome_sw}. ` +
    `Rudi wiki ${weeks}. Piga *384#.`;

  return truncate(msg, 182);
}

// ── English SMS ───────────────────────────────────────────────────────────────

function buildSMS_EN(scoreResult) {
  const { tier, gaps } = scoreResult;
  const meta   = tierMeta(tier);
  const topGap = gaps?.[0];
  const action =
  topGap && ACTIONS[topGap.gap]
    ? ACTIONS[topGap.gap]
    : FALLBACK_ACTION;

const weeks = action.weeks;

  if (tier === 1) {
    return truncate(
      `FarmCredit: ${TIER_LINES[1].en} ` +
      `Loan up to ${meta.limit} available. ` +
      `Branch will contact you. ` +
      `Questions? Dial *384#.`,
      182
    );
  }

  return truncate(
    `FarmCredit: ${TIER_LINES[tier].en} ` +
    `One step: ${action.action_en}. ` +
    `This unlocks ${action.outcome_en}. ` +
    `Check back in ${weeks} weeks. Dial *384#.`,
    182
  );
}

// ── USSD detail text (shown after PIN) ───────────────────────────────────────

function buildUSSDDetail(scoreResult) {
  const { tier, gaps, ptsToNextTier, evidenceProfile } = scoreResult;
  const meta    = tierMeta(tier);
  const topGap  = gaps[0];
  const nextGap = gaps[1];
  const action1 =
  topGap && ACTIONS[topGap.gap]
    ? ACTIONS[topGap.gap]
    : FALLBACK_ACTION;

const action2 =
  nextGap && ACTIONS[nextGap.gap]
    ? ACTIONS[nextGap.gap]
    : null;

  const lines = [];

  lines.push(`${TIER_LINES[tier].sw}`);
  lines.push(`(${TIER_LINES[tier].en})`);
  lines.push(``);

  if (tier === 1) {
    lines.push(`Mkopo: hadi ${meta.limit}`);
    lines.push(`Ofisi itawasiliana nawe.`);
    lines.push(`(Branch will contact you.)`);
  } else {
    lines.push(`Mkopo unaoweza kupata: ${meta.limit || 'Bado / Not yet'}`);
    lines.push(``);
    lines.push(`Hatua ya kwanza:`);
    lines.push(`${action1.action_sw}.`);
    lines.push(`→ Inafungua: ${action1.outcome_sw}.`);
    if (action2) {
      lines.push(``);
      lines.push(`Hatua ya pili:`);
      lines.push(`${action2.action_sw}.`);
    }
    lines.push(``);
    lines.push(`Rudi baada ya wiki ${action1.weeks}.`);
    lines.push(`(Return in ${action1.weeks} weeks.)`);
  }

  // ── Evidence note (only when Neo4j found something) ──────────────────────
  const evidenceNote = buildEvidenceNote(evidenceProfile);
  if (evidenceNote) {
    lines.push(``);
    lines.push(`Jamii yako ilisaidia:`);
    lines.push(`(Your community supported this assessment:)`);
    lines.push(evidenceNote);
  }

  return lines.join('\n');
}

// ── Repayment connection message ──────────────────────────────────────────────

function buildRepaymentLink(tier) {
  if (tier === 1) {
    return (
      `CON Kulipa kwa wakati kunalinda kiwango chako.\n` +
      `(Repaying on time protects your tier.)\n\n` +
      `Kila malipo yako yanaonekana na yanasaidia.\n` +
      `(Every payment you make is seen and counted.)\n\n` +
      `0. Maliza (Exit)`
    );
  }
  return (
    `CON Malipo yako ya mkopo yanaboresha kiwango chako.\n` +
    `(Your loan repayments improve your tier.)\n\n` +
    `Kulipa mapema kunasaidia zaidi ya kulipa kuchelewa.\n` +
    `(Paying early helps more than paying late.)\n\n` +
    `Hii si adhabu — ni fursa yako. Tunakuambia ukweli.\n` +
    `(This is not pressure — it is your opportunity.)\n\n` +
    `0. Maliza (Exit)`
  );
}

// ── Utility ───────────────────────────────────────────────────────────────────

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

module.exports = {
  buildSMS,
  buildSMS_EN,
  buildUSSDDetail,
  buildRepaymentLink,
  buildEvidenceNote,
};