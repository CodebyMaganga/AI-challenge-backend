// services/scoreHelpers.js
/**
 * Risk scoring helpers — ShambAI v2
 *
 * Score breakdown (total 100 points):
 *   Farm tenure signal      → up to 20 pts  (replaces farmSize)
 *   Crop/livestock signal   → up to 10 pts
 *   Community ties signal   → up to 30 pts  (replaces pastLoan as primary)
 *   Loan history signal     → up to 20 pts  (nullable — skipped when community found)
 *   Input access (behavior) → up to 10 pts  (new)
 *   M-Pesa cashflow         → up to 25 pts
 *   Weather risk            → up to 20 pts
 *   Graph signals           → up to 10 pts, minus up to 15 pts penalty
 *
 * Max theoretical: 115 → clamped to 100.
 * This gives breathing room so no single signal dominates.
 */

const { GAPS } = require('./gapConstants');

/**
 * Compute the raw credit score from all available evidence.
 *
 * All parameters reflect the v2 USSD field names.
 * loanHistory is nullable — when loanHistorySkipped is true,
 * it means communityTies was present and we intentionally skipped
 * the question. This is NOT the same as "no loan history."
 */
function computeBaseScore({
  farmAccess,       // 'owned'|'family'|'leased'|'shared'
  leaseLength,      // 'short'|'medium'|'long'|null
  cropType,         // 'crops'|'dairy'|'horticulture'|'mixed'
  herdSize,         // 'small'|'medium'|'large'|'xlarge'|null
  milkCooperative,  // 'monthly'|'occasional'|'none'|null
  communityTies,    // 'chama'|'sacco'|'coop'|'none'
  loanHistory,      // 'repaid_full'|'defaulted'|'repaid_chama'|'no_prior'|null
  inputAccess,      // 'always'|'sometimes'|'rarely'|'never'
  cashflow,
  weather,
  graph,
  loanHistorySkipped, // boolean — true means question was skipped (community found)
}) {
  let score = 0;

  // ── 1. Farm tenure (up to 20 pts) ─────────────────────────────────────────
  // Replaces farmSize. We score stability of land access, not acreage.
  // Family land is treated close to owned — it's often as stable in practice.
  // Leasehold is nuanced: short lease = risky, long lease = near-owned.
  const tenureBase = {
    owned:  20,
    family: 16,  // stable but no legal title — slightly discounted
    shared: 10,
    leased:  8,  // default before lease length is known
  };
  let tenureScore = tenureBase[farmAccess] || 8;

  // Lease length adjustment (only applies if leased)
  if (farmAccess === 'leased' && leaseLength) {
    const leaseAdjust = { short: -3, medium: 0, long: 6 };
    tenureScore += leaseAdjust[leaseLength] || 0;
  }
  score += Math.min(20, Math.max(0, tenureScore));

  // ── 2. Crop/livestock (up to 10 pts) ──────────────────────────────────────
  const cropBase = {
    crops:        8,
    horticulture: 9,   // higher-value, often more regular income
    mixed:        8,
    dairy:        7,   // base score — may be boosted by herd/coop signals below
  };
  let cropScore = cropBase[cropType] || 5;

  // Dairy-specific asset signals
  if (cropType === 'dairy') {
    // Herd size = asset base (replaces collateral signal)
    const herdBonus = { small: 0, medium: 1, large: 2, xlarge: 3 };
    cropScore += herdBonus[herdSize] || 0;

    // Milk cooperative = structured payment behavior (strong signal)
    const milkBonus = { monthly: 3, occasional: 1, none: 0 };
    cropScore += milkBonus[milkCooperative] || 0;
  }
  score += Math.min(10, cropScore);

  // ── 3. Community ties (up to 30 pts) ──────────────────────────────────────
  // This is now the PRIMARY alternative credit signal.
  // Replaces the old "loan history" as the main evidence layer for
  // farmers who have group financial history.
  //
  // Why chama > sacco slightly: chamas have informal group accountability
  // (peer pressure to repay) and often share M-Pesa records. SACCOs are
  // more formal but have less direct peer monitoring per member.
  const communityScores = {
    chama: 28,  // women's savings group — peer accountability + M-Pesa trail
    sacco: 26,  // formal regulated — strong but fewer farmers have access
    coop:  24,  // agricultural cooperative — income + repayment network
    none:   0,
  };
  score += communityScores[communityTies] || 0;

  // ── 4. Loan history (up to 20 pts, nullable) ──────────────────────────────
  // This question was SKIPPED if communityTies was chama/sacco/coop.
  // loanHistorySkipped = true means we intentionally didn't ask — it is
  // NOT a gap, it's a deliberate architectural decision.
  // We only score loanHistory when the question was actually answered.
  if (!loanHistorySkipped && loanHistory !== null && loanHistory !== undefined) {
    const loanScores = {
      repaid_full:   20,
      repaid_chama:  15,  // chama loan repayment — good signal, slightly lower formality
      no_prior:       8,  // neutral — no default history is still evidence
      defaulted:      0,
    };
    score += loanScores[loanHistory] || 0;
  } else if (loanHistorySkipped) {
    // Community ties found → give a neutral 8 pts here
    // (same as 'no_prior') to avoid penalizing the skip
    score += 8;
  }
  // If loanHistory is null and NOT skipped (data error) → 0 pts, no penalty

  // ── 5. Input access — behavioral signal (up to 10 pts) ────────────────────
  // Consistent input purchases = financial planning behavior.
  // 'rarely' and 'never' are noted as structural barriers, not personal failures —
  // they do not subtract from score, they simply don't add.
  const inputScores = {
    always:    10,
    sometimes:  6,
    rarely:     2,  // structural barrier noted — not penalized
    never:      0,
  };
  score += inputScores[inputAccess] || 0;

  // ── 6. M-Pesa cashflow (up to 25 pts) ─────────────────────────────────────
  if (cashflow && cashflow.score !== undefined) {
    score += Math.round((cashflow.score / 100) * 25);
  }

  // ── 7. Weather risk (up to 20 pts) ────────────────────────────────────────
  if (weather && weather.score !== undefined) {
    score += Math.round((weather.score / 100) * 20);
  }

  // ── 8. Graph signals ───────────────────────────────────────────────────────
  if (graph) {
    // Location default rate penalty: up to 15 pts subtracted
    const locationPenalty = Math.round((graph.locationDefaultRate || 0) * 15);
    score -= locationPenalty;

    // Social reputation from peer network: up to 10 pts
    const socialAdd = Math.round(((graph.socialScore || 0) / 100) * 10);
    score += socialAdd;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Convert score to tier.
 * Thresholds unchanged — tier boundaries are lender-configured.
 */
function scoreToTier(score) {
  if (score >= 75) return 1;  // Gold
  if (score >= 60) return 2;  // Silver
  if (score >= 45) return 3;  // Bronze
  return 4;                   // Decline
}

/**
 * Determine the top reason for the score.
 * Updated to use loanHistory and communityTies instead of pastLoan.
 */
function determineTopReason(baseScore, factors) {
  const reasons = [];

  if (factors.cashflow && factors.cashflow.score < 30) {
    reasons.push({ key: 'low_cashflow', weight: 30 - factors.cashflow.score });
  }

  if (factors.weather && factors.weather.score < 40) {
    reasons.push({ key: 'high_weather_risk', weight: 40 - factors.weather.score });
  }

  if (factors.graph && factors.graph.locationDefaultRate > 0.3) {
    reasons.push({ key: 'high_location_risk', weight: factors.graph.locationDefaultRate * 10 });
  }

  if (factors.loanHistory === 'defaulted') {
    reasons.push({ key: 'past_default', weight: 40 });
  }

  if (reasons.length === 0) {
    if (factors.communityTies && factors.communityTies !== 'none') {
      return 'strong_community_ties';
    }
    if (factors.cashflow && factors.cashflow.score > 70) {
      return 'good_cashflow';
    }
    if (factors.graph && factors.graph.socialScore > 80) {
      return 'strong_social_network';
    }
    return 'good_overall';
  }

  reasons.sort((a, b) => b.weight - a.weight);
  return reasons[0].key;
}

/**
 * Detect actionable gaps.
 * Updated field names. loanHistorySkipped gap is suppressed —
 * it is not a real gap, it's intentional architecture.
 */
function detectGaps({
  cashflow,
  weather,
  graph,
  farmAccess,
  loanHistory,
  communityTies,
  inputAccess,
  loanHistorySkipped,
}) {
  const gaps = [];

  // Loan history gaps — only when question was actually asked
  if (!loanHistorySkipped) {
    if (loanHistory === 'no_prior') gaps.push(GAPS.NO_LOAN_HISTORY);
    if (loanHistory === 'defaulted') gaps.push(GAPS.DEFAULTED);
  }

  // No community ties — this IS a real gap worth surfacing
  if (communityTies === 'none') gaps.push(GAPS.NO_COOP);

  // Input access as structural barrier — flag for lender context, not punishment
  if (inputAccess === 'rarely' || inputAccess === 'never') {
    gaps.push(GAPS.NO_GROUP); // reusing closest existing gap key — rename in gapConstants if possible
  }

  // Tenure instability
  if (farmAccess === 'shared') gaps.push(GAPS.SMALL_FARM); // reuse closest key

  // M-Pesa
  if (cashflow && cashflow.score < 30) gaps.push(GAPS.LOW_MPESA);

  const priority = {
    [GAPS.DEFAULTED]:       1,
    [GAPS.NO_LOAN_HISTORY]: 2,
    [GAPS.LOW_MPESA]:       3,
    [GAPS.NO_COOP]:         4,
    [GAPS.SMALL_FARM]:      5,
    [GAPS.NO_GROUP]:        6,
    [GAPS.INACTIVE_COOP]:   7,
  };
  gaps.sort((a, b) => (priority[a] || 99) - (priority[b] || 99));

  return gaps.slice(0, 2).map(gap => ({ gap }));
}

module.exports = { detectGaps, computeBaseScore, scoreToTier, determineTopReason };