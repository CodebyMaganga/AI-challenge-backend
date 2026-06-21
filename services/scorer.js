/**
 * scorer.js
 *
 * Converts USSD answers into an internal credit score.
 * Output is NEVER shown directly to the farmer — it feeds the explainer.
 *
 * Design principles:
 *  - No land title or collateral required
 *  - No age or gender penalty (equity-adjusted)
 *  - Female farmers without prior loan history get a baseline boost
 *    to offset historical data bias in training samples
 *  - M-Pesa is pulled asynchronously; base score uses USSD answers only
 *
 * Signals collected via USSD (6 questions):
 *   crop        — what she grows (context, not scored)
 *   land        — farm size in acres (proxy for income potential)
 *   coop        — cooperative / savings group membership
 *   loan        — prior loan repayment behaviour
 *   group       — chama / peer group active saving
 *   mpesa       — M-Pesa usage self-report (enriched later)
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
    repaid_chama:   200, // informal chama loan repaid — counts strongly
    no_prior:         0, // neutral, not negative
    defaulted:      -150,
  },

  // Cooperative / savings group membership
  coop: {
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

  // M-Pesa usage consistency (self-reported; overridden by enrichment)
  mpesa: {
    daily:          110,
    weekly:          70,
    monthly:         30,
    rarely:           0,
  },

  // Farm size — proxy for income potential, not ownership
  land: {
    under1:   20,
    one_three: 50,
    three_ten: 80,
    over10:   100,
  },

  // Equity boosts — not penalties, only positive adjustments
  equity: {
    female_no_prior_loan:  40, // offset historical data bias
    female_active_group:   20, // chama participation signal upweighted
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
};

// ── Main scoring function ─────────────────────────────────────────────────────

function score(answers) {
  const { crop, land, coop, loan, group, mpesa, gender } = answers;
  let total = 0;
  const breakdown = []; // internal — lender MIS only
  const gaps      = []; // ordered by impact — feeds explainer

  // ── Prior loan ────────────────────────────────────────────────────────────
  const loanPts = W.loan[loan] ?? 0;
  total += loanPts;
  breakdown.push({ signal: 'Prior loan repayment', value: loan, pts: loanPts });

  if (loan === 'no_prior')   gaps.push({ gap: GAPS.NO_LOAN_HISTORY, impact: 300 });
  if (loan === 'defaulted')  gaps.push({ gap: GAPS.DEFAULTED,       impact: 450 }); // 300 recovery + lost pts

  // ── Cooperative ───────────────────────────────────────────────────────────
  const coopPts = W.coop[coop] ?? 0;
  total += coopPts;
  breakdown.push({ signal: 'Cooperative membership', value: coop, pts: coopPts });

  if (coop === 'none')     gaps.push({ gap: GAPS.NO_COOP,      impact: 140 });
  if (coop === 'inactive') gaps.push({ gap: GAPS.INACTIVE_COOP, impact: 110 });

  // ── Chama / peer group ────────────────────────────────────────────────────
  const groupPts = W.group[group] ?? 0;
  total += groupPts;
  breakdown.push({ signal: 'Savings group (chama)', value: group, pts: groupPts });

  if (group === 'none') gaps.push({ gap: GAPS.NO_GROUP, impact: 120 });

  // ── M-Pesa ────────────────────────────────────────────────────────────────
  const mpesaPts = W.mpesa[mpesa] ?? 0;
  total += mpesaPts;
  breakdown.push({ signal: 'M-Pesa activity', value: mpesa, pts: mpesaPts });

  if (mpesa === 'rarely' || mpesa === 'monthly') {
    gaps.push({ gap: GAPS.LOW_MPESA, impact: 110 });
  }

  // ── Farm size ─────────────────────────────────────────────────────────────
  const landPts = W.land[land] ?? 20;
  total += landPts;
  breakdown.push({ signal: 'Farm size', value: land, pts: landPts });

  if (land === 'under1') gaps.push({ gap: GAPS.SMALL_FARM, impact: 80 });

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
  if (finalScore >= 750) tier = 1;
  else if (finalScore >= 500) tier = 2;
  else if (finalScore >= 300) tier = 3;
  else tier = 4;

  // Sort gaps by impact descending — explainer picks the top one
  gaps.sort((a, b) => b.impact - a.impact);

  // Compute what score she needs for next tier
  const tierThresholds = [null, 750, 500, 300, 0];
  const nextTierThreshold = tierThresholds[tier - 1]; // threshold above current tier
  const ptsToNextTier = nextTierThreshold ? Math.max(0, nextTierThreshold - finalScore) : 0;

  return {
    score:    finalScore,
    tier,
    breakdown,      // lender MIS — never shown to farmer
    gaps,           // ordered gaps — feeds explainer
    ptsToNextTier,
    crop,           // context for explainer
    gender,
    scoredAt: new Date(),
  };
}

// ── Tier metadata ─────────────────────────────────────────────────────────────

function tierMeta(tier) {
  const meta = {
    1: { sw: 'Kiwango cha Kwanza', en: 'Tier 1',  limit: 'KES 30,000–50,000', weeks: null  },
    2: { sw: 'Kiwango cha Pili',   en: 'Tier 2',  limit: 'KES 8,000–25,000',  weeks: 8     },
    3: { sw: 'Kiwango cha Tatu',   en: 'Tier 3',  limit: 'KES 2,000–5,000',   weeks: 12    },
    4: { sw: 'Kiwango cha Nne',    en: 'Tier 4',  limit: null,                weeks: 16    },
  };
  return meta[tier];
}

module.exports = { score, tierMeta, GAPS };