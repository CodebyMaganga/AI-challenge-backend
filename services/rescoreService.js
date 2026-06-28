// services/rescoreService.js
const {
  computeBaseScore,
  scoreToTier,
  detectGaps,
  determineTopReason,
} = require('./scoreHelpers');

const Farmer = require('../db/farmerModel');

/**
 * Re‑score a farmer using the latest assessment’s answers & evidence.
 * Appends a new assessment to the history and updates current fields.
 *
 * @param {Object} farmer - Mongoose document (full farmer)
 * @returns {Promise<Object>} The updated farmer (lean object)
 */
async function rescoreFarmer(farmer) {
  const latest = farmer.assessmentHistory?.[0];
  if (!latest) throw new Error('No assessment to rescore');

  // ── Extract inputs for the scoring engine ─────────────────
  const { answers, evidence } = latest;

  // Crop type may be an object { category, crops } – scoring expects string
  const cropTypeForEngine =
    typeof answers.cropType === 'object' && answers.cropType !== null
      ? answers.cropType.category
      : answers.cropType;

  const scoreInput = {
    farmAccess: answers.farmAccess,
    leaseLength: answers.leaseLength || null,
    cropType: cropTypeForEngine,
    herdSize: answers.herdSize || null,
    milkCooperative: answers.milkCooperative || null,
    communityTies: answers.communityTies,
    loanHistory: answers.loanHistory || null,
    inputAccess: answers.inputAccess,
    loanHistorySkipped: answers.loanHistory === null && answers.communityTies !== 'none',
    cashflow: evidence?.mpesaScore ? { score: evidence.mpesaScore } : null,
    weather: evidence?.weatherScore ? { score: evidence.weatherScore } : null,
    graph: {
      socialScore: evidence?.graphSocialScore ?? 0,
      locationDefaultRate: evidence?.locationDefaultRate ?? 0,
      coopRepayRate: evidence?.coopRepayRate ?? null,
      goodNeighbors: evidence?.goodNeighbors ?? 0,
      secondDegreeLinks: evidence?.secondDegreeLinks ?? 0,
    },
  };

  // ── Run the engine ───────────────────────────────────────
  const baseScore = computeBaseScore(scoreInput);
  const tier = scoreToTier(baseScore);
  const gaps = detectGaps(scoreInput);
  const topReason = determineTopReason(baseScore, scoreInput);

  // Calculate points to next tier
  const tierThresholds = { 1: 75, 2: 60, 3: 45 };
  let ptsToNextTier = 0;
  if (tier === 1) {
    ptsToNextTier = 0;
  } else {
    const nextTierMin = tierThresholds[tier - 1] || 0;
    ptsToNextTier = Math.max(0, nextTierMin - baseScore);
  }

  const scoredAt = new Date();

  // ── Build the new assessment snapshot (same shape as USSD) ─
  const newAssessment = {
    scoredAt,
    tier,
    baseScore: baseScore,
    adjustedScore: baseScore,   // no adjustment from Neo4j here – we already used evidence
    topReason,
    gaps: gaps.map(g => g.gap),   // gaps is array of { gap }, store strings
    ptsToNextTier,

    answers: {
      farmAccess: answers.farmAccess,
      leaseLength: answers.leaseLength || null,
      cropType: answers.cropType,          // keep original (may be object)
      herdSize: answers.herdSize || null,
      milkCooperative: answers.milkCooperative || null,
      farmSeason: answers.farmSeason || null,
      communityTies: answers.communityTies,
      loanHistory: answers.loanHistory || null,
      inputAccess: answers.inputAccess,
      consentGiven: answers.consentGiven === true,
    },

    evidence: {
      mpesaScore: evidence?.mpesaScore ?? null,
      weatherScore: evidence?.weatherScore ?? null,
      graphSocialScore: evidence?.graphSocialScore ?? null,
      coopRepayRate: evidence?.coopRepayRate ?? null,
      goodNeighbors: evidence?.goodNeighbors ?? 0,
      secondDegreeLinks: evidence?.secondDegreeLinks ?? 0,
      networkFound: evidence?.networkFound ?? false,
    },

    adaptiveBranches: {},   // not used in re‑score
  };

  // ── Update the farmer document ───────────────────────────
  farmer.assessmentHistory.unshift(newAssessment);
  // Keep only last 10 assessments
  if (farmer.assessmentHistory.length > 10) {
    farmer.assessmentHistory = farmer.assessmentHistory.slice(0, 10);
  }

  farmer.currentTier = tier;
  farmer.currentScore = baseScore;
  farmer.currentTopReason = topReason;
  farmer.lastScoredAt = scoredAt;
  farmer.assessmentCount = (farmer.assessmentCount || 0) + 1;

  await farmer.save();
  return farmer.toObject ? farmer.toObject() : farmer;
}

module.exports = { rescoreFarmer };