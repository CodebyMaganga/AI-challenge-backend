// mpesaService.js (profile-based, no MongoDB)

const PROFILES = {
  maize: {
    long_rains:  { monthsActive:9,  avgInflow:4200, seasonal:true,  saving:false, mobileLoans:false },
    short_rains: { monthsActive:7,  avgInflow:3100, seasonal:true,  saving:false, mobileLoans:false },
    year_round:  { monthsActive:10, avgInflow:3800, seasonal:true,  saving:true,  mobileLoans:false },
  },
  beans: {
    long_rains:  { monthsActive:8,  avgInflow:3500, seasonal:true,  saving:false, mobileLoans:false },
    short_rains: { monthsActive:6,  avgInflow:2800, seasonal:true,  saving:false, mobileLoans:true  },
    year_round:  { monthsActive:9,  avgInflow:3200, seasonal:false, saving:true,  mobileLoans:false },
  },
  dairy: {
    long_rains:  { monthsActive:12, avgInflow:8500, seasonal:false, saving:true,  mobileLoans:false },
    short_rains: { monthsActive:11, avgInflow:7200, seasonal:false, saving:true,  mobileLoans:false },
    year_round:  { monthsActive:12, avgInflow:9100, seasonal:false, saving:true,  mobileLoans:false },
  },
  horticulture: {
    long_rains:  { monthsActive:10, avgInflow:6200, seasonal:false, saving:true,  mobileLoans:false },
    short_rains: { monthsActive:9,  avgInflow:5400, seasonal:false, saving:true,  mobileLoans:true  },
    year_round:  { monthsActive:11, avgInflow:7800, seasonal:false, saving:true,  mobileLoans:false },
  },
  mixed: {
    long_rains:  { monthsActive:10, avgInflow:5100, seasonal:true,  saving:false, mobileLoans:false },
    short_rains: { monthsActive:8,  avgInflow:4200, seasonal:true,  saving:false, mobileLoans:true  },
    year_round:  { monthsActive:11, avgInflow:5800, seasonal:false, saving:true,  mobileLoans:false },
  },
};

function jitter() {
  return 0.85 + Math.random() * 0.3;  // ±15%
}

/**
 * Main entry point for the risk engine.
 * @param {object} appData — { consent, cropType, cropSeason, phone }
 * @returns {object} score data, matching risk engine's expectations.
 */
async function getCashflowScore(appData) {
  const { consent, cropType, cropSeason, phone } = appData;

  if (!consent) {
    return {
      score: 0,
      incomeAvg: 0,
      frequency: 0,
      savingsIndicator: 0,
      source: 'declined',
      note: 'Farmer declined M-Pesa data access',
    };
  }

  const cropKey   = cropType   || 'mixed';
  const seasonKey = cropSeason || 'year_round';
  const base = (PROFILES[cropKey] && PROFILES[cropKey][seasonKey])
    || PROFILES.mixed.year_round;

  const monthsActive = Math.min(12, Math.round(base.monthsActive * jitter()));
  const avgMonthlyInflow = Math.round(base.avgInflow * jitter());

  // Compute consistency score (0–100)
  let cs = 0;
  cs += (monthsActive / 12) * 50;               // up to 50 pts for activity
  if (base.saving)            cs += 20;          // saving behaviour
  if (base.seasonal)          cs += 15;          // harvest-aligned deposits
  if (base.mobileLoansActive) cs -= 20;          // active mobile loans = risk
  cs = Math.max(0, Math.min(100, Math.round(cs)));

  // Translate consistencyScore into the engine's expected format
  // score (0–100) used in weighting; incomeAvg for evidence
  return {
    score: cs,                                   // used in risk engine: cashflow.score
    incomeAvg: avgMonthlyInflow,
    frequency: monthsActive,                     // months active, not monthly txns
    savingsIndicator: base.saving ? 1 : 0,       // simplified boolean
    monthsActive,
    avgMonthlyInflow,
    seasonalPattern: base.seasonal,
    regularSaving: base.saving,
    mobileLoansActive: base.mobileLoansActive,
    consistencyScore: cs,
  };
}

// Optional helper for explainer
function mpesaSignalLabel(mpesaData) {
  if (mpesaData.source === 'declined') return 'M-Pesa: data not shared';
  if (mpesaData.consistencyScore >= 70) return `M-Pesa: strong (${mpesaData.monthsActive}/12 months active)`;
  if (mpesaData.consistencyScore >= 40) return `M-Pesa: moderate (${mpesaData.monthsActive}/12 months active)`;
  return `M-Pesa: limited history (${mpesaData.monthsActive}/12 months active)`;
}

module.exports = { getCashflowScore, mpesaSignalLabel };