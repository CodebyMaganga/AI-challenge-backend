// riskEngine.js
const mpesaService = require('./mpesaService');
const weatherService = require('./weatherService');
const neo4jService = require('./neo4jService');
const { detectGaps, computeBaseScore, scoreToTier, determineTopReason } = require('./scoreHelpers');
const { writeFarmerNode } = require('../db/neo4j');

async function initiateRiskAssessment(appData, phoneHash) {
  const { consent, location, farmSize, cropType, cropSeason, pastLoan, gender } = appData;

  console.log("Starting risk assessment:", appData);
  // 1. M‑Pesa cashflow
  let mpesaFeatures = null;
  if (consent) {
    mpesaFeatures = await mpesaService.getCashflowScore({
      consent,
      cropType,
      cropSeason,
      phone: phoneHash,
    });
  }

  // 2. Weather risk (already correct)
  const weatherRisk = await weatherService.getWeatherRisk (location, cropSeason);

  // 3. Neo4j graph risk (with fallback — see below)
 let graphRisk;
  let enrichedEvidence = { found: false };   // default
  try {
    graphRisk = await neo4jService.getNetworkRisk(phoneHash, location);
    // Build evidence from graph data
    if (graphRisk && graphRisk.connectedPeers > 0) {
      enrichedEvidence.found = true;
      enrichedEvidence.goodNeighbors = graphRisk.connectedPeers;
      if (graphRisk.avgRepayRatio) {
        enrichedEvidence.coopRepayRate = Math.round(graphRisk.avgRepayRatio * 100);
      }
      // enrichedEvidence.coopName = '...'; // if available from graph
    }
  } catch (err) {
    console.warn('Neo4j query failed, using neutral graph risk:', err.message);
    graphRisk = {
      locationDefaultRate: 0,
      locationFarmerCount: 0,
      socialScore: 0,
      connectedPeers: 0,
      avgRepayRatio: 0,
    };
    enrichedEvidence = { found: false };
  }



  // 4. Base score
  const baseScore = computeBaseScore({
    farmSize,
    cropType,
    pastLoan,
    cashflow: mpesaFeatures,
    weather: weatherRisk,
    graph: graphRisk,
  });

  // 5. Fairness adjustment
  let adjustedScore = baseScore;
  if (gender === 'female' && baseScore >= 55 && baseScore < 65) {
    adjustedScore = 65;
  }

  // 6. Tier and reason
  const tier = scoreToTier(adjustedScore);
  const reason = determineTopReason(baseScore, {
    cashflow: mpesaFeatures,
    weather: weatherRisk,
    graph: graphRisk,
    pastLoan,
  });

  // Detect actionable gaps
  const gaps = detectGaps({
    cashflow: mpesaFeatures,
    weather: weatherRisk,
    graph: graphRisk,
    farmSize,
    pastLoan,
  });

   // Points to next tier (approx)
  const tierThresholds = [75, 60, 45, 0]; // for tier 1,2,3,4
  const currentThreshold = tierThresholds[tier - 1] || 0;
  const ptsToNextTier = Math.max(0, currentThreshold - adjustedScore);


  // 7. Evidence
  const evidenceProfile = {
    baseScore,
    adjustedScore,
    tier,
    topReason: reason,
    factors: {
      mpesa: mpesaFeatures,
      weather: weatherRisk,
      graph: graphRisk,
    },
  };

  // 8. Update Neo4j (fire & forget, may fail safely)
  writeFarmerNode({
    phoneHash,
    gender,
    tier,
    location,
    crop: cropType,
  }).catch(err => console.warn('Neo4j write failed (non‑critical):', err.message));

  return {
    tier,
    gaps,
    ptsToNextTier,
    evidenceProfile: enrichedEvidence,
    scoredAt: new Date().toISOString(),
  };
}

module.exports = { initiateRiskAssessment };