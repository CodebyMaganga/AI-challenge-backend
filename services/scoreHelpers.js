// services/scoreHelpers.js
/**
 * Risk scoring helpers — used by riskEngine.js
 *
 * All scores are 0–100.
 * Tier mapping: 1 = Gold, 2 = Silver, 3 = Bronze, 4 = Decline
 */

const { GAPS } = require('./gapConstants');
/**
 * Compute the raw credit score from all available features (no gender).
 */
function computeBaseScore({ farmSize, cropType, pastLoan, cashflow, weather, graph }) {
  let score = 0;

  // 1. Farm size (up to 20 points)
  const sizeScores = {
    '<0.5': 5,
    '0.5-2': 10,
    '2-5': 15,
    '5-10': 20,
    '>10': 20,
  };
  score += sizeScores[farmSize] || 5;

  // 2. Crop type stability (up to 10 points)
  const cropScores = {
    maize: 10,
    beans: 8,
    dairy: 7,
    horticulture: 9,
    mixed: 8,
  };
  score += cropScores[cropType] || 5;

  // 3. Past loan behaviour (up to 30 points)
  const pastScores = {
    repaid_full: 30,
    repaid_partial: 15,
    defaulted: 0,
    repaid_chama: 20,
    no_prior: 10,
  };
  score += pastScores[pastLoan] || 0;

  // 4. Cashflow (M‑Pesa) — up to 25 points
  if (cashflow && cashflow.score !== undefined) {
    score += Math.round((cashflow.score / 100) * 25);
  }

  // 5. Weather risk — up to 20 points
  if (weather && weather.score !== undefined) {
    score += Math.round((weather.score / 100) * 20);
  }

  // 6. Graph signals
  if (graph) {
    // Location default rate penalty: subtract up to 15 points
    const locationPenalty = Math.round((graph.locationDefaultRate || 0) * 15);
    score -= locationPenalty;

    // Social reputation: add up to 10 points
    const socialAdd = Math.round(((graph.socialScore || 0) / 100) * 10);
    score += socialAdd;
  }

  // Clamp to 0–100
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Convert a raw score (0–100) into a credit tier (1–4).
 */
function scoreToTier(score) {
  if (score >= 75) return 1;   // Gold
  if (score >= 60) return 2;   // Silver
  if (score >= 45) return 3;   // Bronze
  return 4;                    // Decline
}

/**
 * Identify the most impactful negative reason for the final score.
 * Returns a string key like 'low_cashflow', 'high_weather_risk', etc.
 */
function determineTopReason(baseScore, factors) {
  // We look for the factor that most contributed to a lower score
  const reasons = [];

  // Cashflow weakness
  if (factors.cashflow && factors.cashflow.score < 30) {
    reasons.push({ key: 'low_cashflow', weight: 30 - factors.cashflow.score });
  }

  // Weather risk
  if (factors.weather && factors.weather.score < 40) {
    reasons.push({ key: 'high_weather_risk', weight: 40 - factors.weather.score });
  }

  // High location default rate
  if (factors.graph && factors.graph.locationDefaultRate > 0.3) {
    reasons.push({ key: 'high_location_risk', weight: factors.graph.locationDefaultRate * 10 });
  }

  // Past default is a strong negative flag
  if (factors.pastLoan === 'defaulted') {
    reasons.push({ key: 'past_default', weight: 40 });
  }

  // If no strong negatives, pick a positive reason
  if (reasons.length === 0) {
    if (factors.cashflow && factors.cashflow.score > 70) {
      return 'good_cashflow';
    }
    if (factors.graph && factors.graph.socialScore > 80) {
      return 'strong_social_network';
    }
    return 'good_overall';
  }

  // Return the most impactful negative reason
  reasons.sort((a, b) => b.weight - a.weight);
  return reasons[0].key;
}

function detectGaps({ cashflow, weather, graph, farmSize, pastLoan, cropType }) {
  const gaps = [];

  // Past loan signals
  if (pastLoan === 'no_prior') gaps.push(GAPS.NO_LOAN_HISTORY);
  if (pastLoan === 'defaulted') gaps.push(GAPS.DEFAULTED);

  // Farm size
  if (farmSize === '<0.5' || farmSize === '0.5-2') gaps.push(GAPS.SMALL_FARM);

  // M‑Pesa
  if (cashflow && cashflow.score < 30) gaps.push(GAPS.LOW_MPESA);

  // Cooperative (no data yet from USSD, but you can keep the old coop question if needed)
  // For now, we can assume no coop data → skip, or you can add it back to the flow.
  // If you still collect coop info, include:
  // if (coop === 'none') gaps.push(GAPS.NO_COOP);
  // if (coop === 'inactive') gaps.push(GAPS.INACTIVE_COOP);

  // Group savings (also not currently collected)
  // if (group === 'none') gaps.push(GAPS.NO_GROUP);

  // Weather risk can be a factor, but it's not a "gap" the farmer can fix,
  // so we don't include it in the actionable list.

  // Sort by impact (you can weight them or just use this rough order)
  const priority = {
    [GAPS.DEFAULTED]: 1,
    [GAPS.NO_LOAN_HISTORY]: 2,
    [GAPS.LOW_MPESA]: 3,
    [GAPS.SMALL_FARM]: 4,
    [GAPS.NO_COOP]: 5,
    [GAPS.INACTIVE_COOP]: 6,
    [GAPS.NO_GROUP]: 7,
  };
  gaps.sort((a, b) => (priority[a] || 99) - (priority[b] || 99));

  return gaps.slice(0, 2).map(gap => ({ gap })); // top two gaps
}

module.exports = { detectGaps,computeBaseScore, scoreToTier, determineTopReason };