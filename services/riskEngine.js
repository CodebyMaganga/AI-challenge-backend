/**
 * riskEngine.js — orchestrates the full credit risk assessment
 *
 * Called once after the farmer confirms their USSD answers.
 * Runs all data sources in parallel where possible, then combines
 * into a final score, tier, and explanation.
 *
 * Pipeline:
 *   1. Base score    — weighted USSD answers (sync, instant)
 *   2. M-Pesa score  — simulated transaction history (sync in prototype)
 *   3. Weather risk  — NASA POWER API by county (async, 4s timeout)
 *   4. Network bonus — Neo4j cooperative graph query (async)
 *   → Combine → tier → explainer → SMS
 *
 * Score breakdown (max ~1000):
 *   Base USSD signals   0–620  (loan history, coop, group, farm size)
 *   M-Pesa consistency  0–110  (transaction activity)
 *   Weather penalty     0 to -80 (climate risk by county)
 *   Neo4j network bonus 0–120  (cooperative repayment rate)
 *   Equity adjustment   0–60   (gender equity, no penalties)
 */

const { score: baseScore } = require('./scorer');
const { simulateMpesa, mpesaSignalLabel } = require('./mpesaService');
const { getWeatherRisk } = require('./weatherService');
const { getNetworkBonus } = require('../db/neo4j');
const { buildSMS } = require('./explainer');

// ── Map USSD answers to scorer-compatible keys ────────────────────────────────

function mapToScorerInput(data) {
  // Farm size from USSD → scorer land keys
  const sizeToLand = {
    '<0.5':  'under1',
    '0.5-2': 'one_three',
    '2-5':   'three_ten',
    '5-10':  'three_ten',
    '>10':   'over10',
  };

  return {
    crop:   data.cropType   || 'mixed',
    land:   sizeToLand[data.farmSize] || 'one_three',
    coop:   data.coop       || 'none',      // not in new flow — defaults to none
    loan:   data.pastLoan   || 'no_prior',
    group:  data.group      || 'none',      // not in new flow — defaults to none
    mpesa:  'weekly',                       // placeholder — overridden by mpesaScore
    gender: data.gender     || 'unspecified',
  };
}

// ── Main orchestration function ───────────────────────────────────────────────

async function initiateRiskAssessment(applicationData, phoneHash) {
  const {
    phone,
    consent,
    location,
    farmSize,
    cropType,
    cropSeason,
    pastLoan,
    gender,
  } = applicationData;

  // ── Step 1: Base score (sync — fast) ──────────────────────────────────────
  const scorerInput = mapToScorerInput({ cropType, farmSize, pastLoan, gender });
  const base = baseScore(scorerInput);

  // ── Steps 2, 3, 4: Run in parallel ───────────────────────────────────────
  const [mpesaData, weatherData, networkData] = await Promise.allSettled([
    // M-Pesa simulation (sync but wrapped for consistency)
    Promise.resolve(simulateMpesa({ phone, cropType, cropSeason, consent })),
    // Weather risk from NASA POWER API
    getWeatherRisk({ location, cropSeason, cropType }),
    // Neo4j network bonus
    getNetworkBonus(phoneHash).catch(() => ({ bonus: 0, reason: null })),
  ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

  // Safe fallbacks if any step failed
  const mpesa   = mpesaData   || { mpesaScore: 0, consistencyScore: 0, source: 'error' };
  const weather = weatherData || { weatherScore: 0, climateRiskIndex: 5, droughtRisk: 'moderate', county: location };
  const network = networkData || { bonus: 0, reason: null };

  // ── Step 5: Combine scores ────────────────────────────────────────────────
  const rawScore =
    base.score          +   // USSD signals (0–620)
    mpesa.mpesaScore    +   // M-Pesa consistency (0–110)
    weather.weatherScore+   // Climate penalty (0 to -80)
    network.bonus;          // Network bonus (0–120, or -40 penalty)

  const finalScore = Math.max(0, Math.min(1000, Math.round(rawScore)));

  // ── Step 6: Tier ─────────────────────────────────────────────────────────
  let tier = 4;
  if      (finalScore >= 640) tier = 1;
  else if (finalScore >= 420) tier = 2;
  else if (finalScore >= 220) tier = 3;

  // ── Step 7: Build evidence profile for MIS / lender dashboard ────────────
  const evidenceProfile = {
    baseScore:         base.score,
    mpesaScore:        mpesa.mpesaScore,
    mpesaMonths:       mpesa.monthsActive,
    mpesaConsistency:  mpesa.consistencyScore,
    mpesaSource:       mpesa.source,
    weatherScore:      weather.weatherScore,
    climateRiskIndex:  weather.climateRiskIndex,
    droughtRisk:       weather.droughtRisk,
    county:            weather.county,
    networkBonus:      network.bonus,
    networkReason:     network.reason,
    finalScore,
    tier,
    signals: [
      { label: 'Prior loan repayment',   pts: base.breakdown?.find(b => b.signal.includes('loan'))?.pts || 0,  src: 'USSD self-report' },
      { label: 'Cooperative membership', pts: base.breakdown?.find(b => b.signal.includes('Coop'))?.pts || 0,  src: 'USSD self-report' },
      { label: 'Savings group',          pts: base.breakdown?.find(b => b.signal.includes('group'))?.pts || 0, src: 'USSD self-report' },
      { label: 'Farm size',              pts: base.breakdown?.find(b => b.signal.includes('Farm'))?.pts || 0,  src: 'USSD self-report' },
      { label: 'M-Pesa consistency',     pts: mpesa.mpesaScore,    src: mpesaSignalLabel(mpesa)          },
      { label: 'Climate risk (penalty)', pts: weather.weatherScore, src: `NASA POWER — ${weather.county}` },
      { label: 'Network bonus',          pts: network.bonus,        src: 'Neo4j cooperative graph'        },
    ],
  };

  // ── Step 8: Build result object (same shape as scorer.js output) ──────────
  const result = {
    score:          finalScore,
    tier,
    baseScore:      base.score,
    networkBonus:   network.bonus,
    networkReason:  network.reason,
    gaps:           base.gaps || [],
    breakdown:      base.breakdown || [],
    evidenceProfile,
    scoredAt:       new Date(),
    crop:           cropType,
    gender,
    // Weather recommendation surfaces in explainer
    weatherRecommendation: weather.recommendation,
    weatherRisk:    weather.droughtRisk,
  };

  // Log for debugging
  console.log(`\n📊 Risk Assessment Complete`);
  console.log(`   Phone: ...${phone.slice(-4)}`);
  console.log(`   Base: ${base.score} | M-Pesa: +${mpesa.mpesaScore} | Weather: ${weather.weatherScore} | Network: +${network.bonus}`);
  console.log(`   Final: ${finalScore}/1000 → Tier ${tier}`);
  console.log(`   Climate: ${weather.droughtRisk} (${weather.county}, index ${weather.climateRiskIndex})`);
  console.log(`   M-Pesa: ${mpesa.consistencyScore}/100 consistency, ${mpesa.monthsActive}/12 months active`);
  if (network.bonus !== 0) console.log(`   Network: ${network.reason}`);

  return result;
}

module.exports = { initiateRiskAssessment };