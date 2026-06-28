// services/riskEngine.js
const mpesaService      = require('./mpesaService');
const weatherService    = require('./weatherService');
const neo4jService      = require('./neo4jService');
const { detectGaps, computeBaseScore, scoreToTier, determineTopReason } = require('./scoreHelpers');

async function initiateRiskAssessment(appData, phoneHash) {
  const {
    consent,
    location,
    farmAccess,
    leaseLength,
    cropType,
    farmSeason,
    herdSize,
    milkCooperative,
    communityTies,
    loanHistory,
    inputAccess,
    adaptiveBranches,
  } = appData;

  console.log('═══════════════════════════════════════');
  console.log('🔵 riskEngine START');
  console.log('   phoneHash:', phoneHash);
  console.log('   location:', location);
  console.log('   farmAccess:', farmAccess);
  console.log('   cropType:', cropType);
  console.log('   communityTies:', communityTies);
  console.log('   loanHistory:', loanHistory);
  console.log('   inputAccess:', inputAccess);
  console.log('   consent:', consent);
  console.log('   adaptiveBranches:', adaptiveBranches);
  console.log('═══════════════════════════════════════');

  // ── 1. M-Pesa cashflow ────────────────────────────────────────────────────
  let mpesaFeatures = null;
  if (consent) {
    console.log('📱 Fetching M-Pesa cashflow...');
    mpesaFeatures = await mpesaService.getCashflowScore({
      consent,
      cropType,
      cropSeason: farmSeason,
      phone: phoneHash,
    });
    console.log('📱 M-Pesa result:', JSON.stringify(mpesaFeatures, null, 2));
  } else {
    console.log('📱 M-Pesa skipped — no consent');
  }

  // ── 2. Weather risk ───────────────────────────────────────────────────────
  console.log('🌦️  Fetching weather risk for:', location, farmSeason);
  const weatherRisk = await weatherService.getWeatherRisk(location, farmSeason);
  console.log('🌦️  Weather result:', JSON.stringify(weatherRisk, null, 2));

  // ── 3. Neo4j network risk ─────────────────────────────────────────────────
  let graphRisk;
  let enrichedEvidence = { found: false };

  try {
    console.log('🕸️  Fetching Neo4j network risk...');
    graphRisk = await neo4jService.getNetworkRisk(phoneHash, location);
    console.log('🕸️  Graph result:', JSON.stringify(graphRisk, null, 2));

    if (graphRisk && graphRisk.connectedPeers > 0) {
      enrichedEvidence.found         = true;
      enrichedEvidence.goodNeighbors = graphRisk.connectedPeers;
      if (graphRisk.avgRepayRatio) {
        enrichedEvidence.coopRepayRate = Math.round(graphRisk.avgRepayRatio * 100);
      }
      console.log('🕸️  Graph evidence found:', enrichedEvidence);
    } else {
      console.log('🕸️  No graph evidence found — peers:', graphRisk?.connectedPeers);
    }
  } catch (err) {
    console.warn('🕸️  Neo4j query failed, using neutral:', err.message);
    graphRisk = {
      locationDefaultRate: 0,
      locationFarmerCount: 0,
      socialScore:         0,
      connectedPeers:      0,
      avgRepayRatio:       0,
    };
  }

  // ── 4. Base score ─────────────────────────────────────────────────────────
  console.log('📊 Computing base score...');
  const scoreInputs = {
    farmAccess,
    leaseLength,
    cropType,
    herdSize,
    milkCooperative,
    communityTies,
    loanHistory,
    inputAccess,
    cashflow: mpesaFeatures,
    weather:  weatherRisk,
    graph:    graphRisk,
    loanHistorySkipped: adaptiveBranches?.loanHistorySkipped || false,
  };
  console.log('📊 Score inputs:', JSON.stringify(scoreInputs, null, 2));

  const baseScore = computeBaseScore(scoreInputs);
  console.log('📊 baseScore:', baseScore);

  const adjustedScore = baseScore;
  console.log('📊 adjustedScore:', adjustedScore);

  // ── 5. Tier and reason ────────────────────────────────────────────────────
  const tier   = scoreToTier(adjustedScore);
  const reason = determineTopReason(baseScore, {
    cashflow:      mpesaFeatures,
    weather:       weatherRisk,
    graph:         graphRisk,
    loanHistory,
    communityTies,
  });
  console.log('🏅 tier:', tier, '| reason:', reason);

  // ── 6. Gaps ───────────────────────────────────────────────────────────────
  const gaps = detectGaps({
    cashflow:      mpesaFeatures,
    weather:       weatherRisk,
    graph:         graphRisk,
    farmAccess,
    loanHistory,
    communityTies,
    inputAccess,
    loanHistorySkipped: adaptiveBranches?.loanHistorySkipped || false,
  });
  console.log('🔍 gaps:', gaps);

  // ── 7. Points to next tier ────────────────────────────────────────────────
  const tierThresholds = [75, 60, 45, 0];
  const currentThreshold = tierThresholds[tier - 1] || 0;
  const ptsToNextTier = Math.max(0, currentThreshold - adjustedScore);

  // ── 8. Full evidence profile (for farmerStore) ────────────────────────────
  // IMPORTANT: we attach the full evidenceProfile to the return value
  // so farmerStore.saveFarmerAssessment can read factors.adjustedScore etc.
  const fullEvidenceProfile = {
    baseScore,
    adjustedScore,
    tier,
    topReason: reason,
    factors: {
      mpesa:         mpesaFeatures,
      weather:       weatherRisk,
      graph:         graphRisk,
      communityTies,
      loanHistory,
      inputAccess,
      farmAccess,
    },
    // also spread enrichedEvidence so farmerStore can read .found, .goodNeighbors etc
    ...enrichedEvidence,
  };

  const result = {
    tier,
    gaps,
    ptsToNextTier,
    evidenceProfile: fullEvidenceProfile,   // ← FIXED: was enrichedEvidence only
    scoredAt: new Date().toISOString(),
  };

  console.log('✅ riskEngine FINAL RESULT:');
  console.log('   tier:', result.tier);
  console.log('   baseScore:', baseScore);
  console.log('   adjustedScore:', adjustedScore);
  console.log('   evidenceProfile.factors exists:', !!result.evidenceProfile.factors);
  console.log('═══════════════════════════════════════');

  return result;
}

module.exports = { initiateRiskAssessment };