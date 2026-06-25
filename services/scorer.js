/**
 * scorer.js — domain‑aware credit score (dairy + mixed support)
 *
 * Converts USSD answers into an internal credit score.
 * Output is NEVER shown directly to the farmer — it feeds the explainer.
 *
 * Design principles:
 *  - No land title or collateral required
 *  - No age or gender penalty (equity‑adjusted)
 *  - Female farmers without prior loan history get a baseline boost
 *    to offset historical data bias in training samples
 *  - M‑Pesa is pulled asynchronously; base score uses USSD answers only
 *
 * Signals collected via USSD (varies by crop):
 *   crop        — what she grows (context, not scored)
 *   land        — farm size in acres (maize/beans/horticulture)
 *   coop        — agricultural cooperative (maize/beans/horticulture)
 *   herd        — number of dairy cows (dairy)
 *   milkcoop    — milk cooperative membership (dairy)
 *   combined    — farm size + livestock combined (mixed)
 *   loan        — prior loan repayment behaviour
 *   group       — chama / peer group active saving
 *   mpesa       — M‑Pesa usage self‑report (enriched later)
 *
 * Tiers (what the farmer sees):
 *   Tier 1 — score 750–1000  — "Kiwango cha Kwanza"  (approved, full limit)
 *   Tier 2 — score 500–749   — "Kiwango cha Pili"    (approved, smaller limit)
 *   Tier 3 — score 300–499   — "Kiwango cha Tatu"    (starter loan only)
 *   Tier 4 — score 0–299     — "Kiwango cha Nne"     (not yet — next steps)
 */

// ── Signal weights ─────────────────────────────────────────────────────────────

const W = {
  // Prior loan repayment — strongest predictor
  loan: {
    repaid_full:    300,
    repaid_partial: 100,
    repaid_chama:   200,
    no_prior:         0,
    defaulted:      -150,
  },

  // Cooperative / savings group membership (general & milk)
  coop: {
    active_over2yr:  140,
    active_under2yr:  80,
    inactive:         30,
    none:              0,
  },
  milkcoop: {   // same weights, just a separate signal name for clarity
    active_over2yr:  140,
    active_under2yr:  80,
    inactive:         30,
    none:              0,
  },

  // Chama / peer group active saving
  group: {
    active_saving:  120,
    occasional:      50,
    none:             0,
  },

  // M‑Pesa usage consistency (self‑reported; overridden by enrichment)
  mpesa: {
    daily:          110,
    weekly:          70,
    monthly:         30,
    rarely:           0,
  },

  // Farm size — proxy for income potential (crop farmers)
  land: {
    under1:    20,
    one_three: 50,
    three_ten: 80,
    over10:   100,
  },

  // Dairy herd size — proxy for milk income
  herd: {
    '1-2':    20,
    '3-5':    50,
    '6-10':   80,
    'over10': 100,
  },

  // Combined farm + livestock (mixed farmers)
  combined: {
    small_farm_few:         { land: 'under1',    herd: '1-2'    },
    medium_farm_moderate:   { land: 'one_three', herd: '3-5'    },
    large_farm_many:        { land: 'three_ten', herd: '6-10'   },
    very_large_farm_many:   { land: 'over10',    herd: 'over10' },
  },

  // Equity boosts — only positive adjustments
  equity: {
    female_no_prior_loan:  40,
    female_active_group:   20,
  },
};

// ── Gap labels — used by explainer to pick the right action tip ───────────────

const GAPS = {
  NO_LOAN_HISTORY:    'no_loan_history',
  DEFAULTED:          'defaulted',
  NO_COOP:            'no_coop',
  INACTIVE_COOP:      'inactive_coop',
  NO_GROUP:           'no_group',
  LOW_MPESA:          'low_mpesa',
  SMALL_FARM:         'small_farm',
  SMALL_HERD:         'small_herd',
  NO_MILKCOOP:        'no_milkcoop',
};

// ── Main scoring function ─────────────────────────────────────────────────────

function score(answers) {
  const { crop, loan, group, mpesa, gender } = answers;
  let total = 0;
  const breakdown = [];
  const gaps = [];

  // ── Prior loan ────────────────────────────────────────────────────────────
  const loanPts = W.loan[loan] ?? 0;
  total += loanPts;
  breakdown.push({ signal: 'Prior loan repayment', value: loan, pts: loanPts });

  if (loan === 'no_prior')   gaps.push({ gap: GAPS.NO_LOAN_HISTORY, impact: 300 });
  if (loan === 'defaulted')  gaps.push({ gap: GAPS.DEFAULTED,       impact: 450 });

  // ── Cooperative / Milk cooperative ────────────────────────────────────────
  if (crop === 'dairy') {
    const milkcoopVal = answers.milkcoop || 'none';
    const coopPts = W.milkcoop[milkcoopVal] ?? 0;
    total += coopPts;
    breakdown.push({ signal: 'Milk cooperative membership', value: milkcoopVal, pts: coopPts });
    if (milkcoopVal === 'none')     gaps.push({ gap: GAPS.NO_MILKCOOP,   impact: 140 });
    if (milkcoopVal === 'inactive') gaps.push({ gap: GAPS.INACTIVE_COOP, impact: 110 });
  } else if (crop === 'mixed') {
    breakdown.push({ signal: 'Cooperative membership', value: 'none', pts: 0 });
  } else {
    const coopVal = answers.coop || 'none';
    const coopPts = W.coop[coopVal] ?? 0;
    total += coopPts;
    breakdown.push({ signal: 'Cooperative membership', value: coopVal, pts: coopPts });
    if (coopVal === 'none')     gaps.push({ gap: GAPS.NO_COOP,       impact: 140 });
    if (coopVal === 'inactive') gaps.push({ gap: GAPS.INACTIVE_COOP, impact: 110 });
  }

  // ── Chama / peer group ────────────────────────────────────────────────────
  const groupPts = W.group[group] ?? 0;
  total += groupPts;
  breakdown.push({ signal: 'Savings group (chama)', value: group, pts: groupPts });
  if (group === 'none') gaps.push({ gap: GAPS.NO_GROUP, impact: 120 });

  // ── M‑Pesa ────────────────────────────────────────────────────────────────
  const mpesaPts = W.mpesa[mpesa] ?? 0;
  total += mpesaPts;
  breakdown.push({ signal: 'M-Pesa activity', value: mpesa, pts: mpesaPts });
  if (mpesa === 'rarely' || mpesa === 'monthly') {
    gaps.push({ gap: GAPS.LOW_MPESA, impact: 110 });
  }

  // ── Farm / Herd / Combined signal ─────────────────────────────────────────
  if (crop === 'dairy') {
    const herdVal = answers.herd || '1-2';
    const herdPts = W.herd[herdVal] ?? 20;
    total += herdPts;
    breakdown.push({ signal: 'Dairy herd size', value: herdVal, pts: herdPts });
    if (herdVal === '1-2') gaps.push({ gap: GAPS.SMALL_HERD, impact: 80 });
  } else if (crop === 'mixed') {
    const combinedVal = answers.combined || 'small_farm_few';
    const parts = W.combined[combinedVal];
    if (parts) {
      const landPts = W.land[parts.land] ?? 20;
      const herdPts = W.herd[parts.herd] ?? 20;
      total += landPts + herdPts;
      breakdown.push({ signal: 'Farm size (from combined)', value: parts.land, pts: landPts });
      breakdown.push({ signal: 'Livestock (from combined)', value: parts.herd, pts: herdPts });
      if (parts.land === 'under1') gaps.push({ gap: GAPS.SMALL_FARM, impact: 80 });
      if (parts.herd === '1-2')    gaps.push({ gap: GAPS.SMALL_HERD, impact: 80 });
    }
  } else {
    const landVal = answers.land || 'under1';
    const landPts = W.land[landVal] ?? 20;
    total += landPts;
    breakdown.push({ signal: 'Farm size', value: landVal, pts: landPts });
    if (landVal === 'under1') gaps.push({ gap: GAPS.SMALL_FARM, impact: 80 });
  }

  // ── Equity adjustments (only positive) ───────────────────────────────────
  if (gender === 'female') {
    if (loan === 'no_prior') {
      total += W.equity.female_no_prior_loan;
      breakdown.push({ signal: 'Equity: female, no prior loan baseline', pts: W.equity.female_no_prior_loan });
    }
    if (group === 'active_saving') {
      total += W.equity.female_active_group;
      breakdown.push({ signal: 'Equity: female chama participation upweight', pts: W.equity.female_active_group });
    }
  }

  // ── Clamp + tier ─────────────────────────────────────────────────────────
  const finalScore = Math.max(0, Math.min(1000, Math.round(total)));

  let tier;
  if (finalScore >= 640) tier = 1;
  else if (finalScore >= 420) tier = 2;
  else if (finalScore >= 220) tier = 3;
  else tier = 4;

  gaps.sort((a, b) => b.impact - a.impact);

  const tierThresholds = [null, 640, 420, 220, 0];
  const nextTierThreshold = tierThresholds[tier - 1];
  const ptsToNextTier = nextTierThreshold ? Math.max(0, nextTierThreshold - finalScore) : 0;

  return {
    score:    finalScore,
    tier,
    breakdown,
    gaps,
    ptsToNextTier,
    crop,
    gender,
    scoredAt: new Date(),
  };
}

// ── Tier metadata ─────────────────────────────────────────────────────────────

function tierMeta(tier) {
  const meta = {
    1: { sw: 'Kiwango cha Kwanza', en: 'Tier 1',  limit: 'KES 30,000–50,000', weeks: null },
    2: { sw: 'Kiwango cha Pili',   en: 'Tier 2',  limit: 'KES 8,000–25,000',  weeks: 8    },
    3: { sw: 'Kiwango cha Tatu',   en: 'Tier 3',  limit: 'KES 2,000–5,000',   weeks: 12   },
    4: { sw: 'Kiwango cha Nne',    en: 'Tier 4',  limit: null,                weeks: 16   },
  };
  return meta[tier];
}

// ── Score with Neo4j evidence layer ──────────────────────────────────────────

/**
 * Runs the base rules score then layers Neo4j evidence on top.
 *
 * Returns the full result object with:
 *   baseScore       — rules-only score
 *   evidenceProfile — full structured evidence from Neo4j (or null if unavailable)
 *   score           — final score after evidence adjustment
 *   tier            — final tier after evidence adjustment
 *   networkBonus    — kept for backward compatibility (= evidenceProfile.adjustment)
 *   networkReason   — kept for backward compatibility (= evidenceProfile.signals[0])
 */
async function scoreWithNetwork(answers, phoneHash) {
  const base = score(answers);

  try {
    const { getEvidenceProfile } = require('../db/neo4j');
    const evidenceProfile = await getEvidenceProfile(phoneHash);

    if (evidenceProfile.adjustment !== 0 || evidenceProfile.found) {
      const newScore = Math.max(0, Math.min(1000, base.score + evidenceProfile.adjustment));

      let newTier;
      if (newScore >= 640) newTier = 1;
      else if (newScore >= 420) newTier = 2;
      else if (newScore >= 220) newTier = 3;
      else newTier = 4;

      return {
        ...base,
        score:          newScore,
        tier:           newTier,
        baseScore:      base.score,
        evidenceProfile,
        // Backward-compatible fields
        networkBonus:   evidenceProfile.adjustment,
        networkReason:  evidenceProfile.signals.length > 0 ? evidenceProfile.signals[0] : null,
      };
    }

    // Neo4j found nothing — return base score with empty evidence attached
    return {
      ...base,
      baseScore:      base.score,
      evidenceProfile,
      networkBonus:   0,
      networkReason:  null,
    };

  } catch (err) {
    console.warn('Network scoring skipped:', err.message);
    return {
      ...base,
      baseScore:      base.score,
      evidenceProfile: null,
      networkBonus:   0,
      networkReason:  null,
    };
  }
}

module.exports = { score, scoreWithNetwork, tierMeta, GAPS };