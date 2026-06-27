// services/riskEngine.js
/**
 * Risk assessment engine — ShambAI v2
 *
 * Field changes from v1 → v2 (driven by ussdFlow.js redesign):
 *   farmSize    → removed (replaced by farmAccess + leaseLength)
 *   cropSeason  → farmSeason (nullable — dairy farmers don't have seasons)
 *   pastLoan    → loanHistory (nullable — skipped when communityTies found)
 *   gender      → removed entirely (never used for scoring)
 *   NEW: communityTies, inputAccess, farmAccess, leaseLength,
 *        herdSize, milkCooperative, adaptiveBranches
 *
 * writeFarmerNode is NOT called here — ussdFlow.js calls it before
 * initiateRiskAssessment runs. Calling it twice caused a race condition
 * and a stale gender write.
 */

const mpesaService      = require('./mpesaService');
const weatherService    = require('./weatherService');
const neo4jService      = require('./neo4jService');
const { detectGaps, computeBaseScore, scoreToTier, determineTopReason } = require('./scoreHelpers');

async function initiateRiskAssessment(appData, phoneHash) {
  const {
    consent,
    location,
    farmAccess,       // 'owned' | 'family' | 'leased' | 'shared'
    leaseLength,      // 'short' | 'medium' | 'long' | null
    cropType,         // 'crops' | 'dairy' | 'horticulture' | 'mixed'
    farmSeason,       // 'long_rains' | 'short_rains' | 'year_round' | null (dairy)
    herdSize,         // 'small'|'medium'|'large'|'xlarge' | null (non-dairy)
    milkCooperative,  // 'monthly'|'occasional'|'none' | null (non-dairy)
    communityTies,    // 'chama'|'sacco'|'coop'|'none'
    loanHistory,      // 'repaid_full'|'defaulted'|'repaid_chama'|'no_prior' | null (skipped)
    inputAccess,      // 'always'|'sometimes'|'rarely'|'never'
    adaptiveBranches, // { wasDairy, hasGroupFinance, wasLeased, loanHistorySkipped }
  } = appData;

  console.log('Starting risk assessment v2:', {
    phoneHash,
    location,
    farmAccess,
    cropType,
    communityTies,
    loanHistorySkipped: adaptiveBranches?.loanHistorySkipped,
  });

  // ── 1. M-Pesa cashflow ─────────────────────────────────────────────────────
  let mpesaFeatures = null;
  if (consent) {
    mpesaFeatures = await mpesaService.getCashflowScore({
      consent,
      cropType,
      cropSeason: farmSeason, // may be null for dairy — mpesaService should handle
      phone: phoneHash,
    });
  }

  // ── 2. Weather risk ────────────────────────────────────────────────────────
  // farmSeason may be null for dairy farmers. Pass it anyway — weatherService
  // should return a location-only risk if season is null.
  const weatherRisk = await weatherService.getWeatherRisk(location, farmSeason);

  // ── 3. Neo4j network risk ──────────────────────────────────────────────────
  let graphRisk;
  let enrichedEvidence = { found: false };

  try {
    graphRisk = await neo4jService.getNetworkRisk(phoneHash, location);

    if (graphRisk && graphRisk.connectedPeers > 0) {
      enrichedEvidence.found         = true;
      enrichedEvidence.goodNeighbors = graphRisk.connectedPeers;
      if (graphRisk.avgRepayRatio) {
        enrichedEvidence.coopRepayRate = Math.round(graphRisk.avgRepayRatio * 100);
      }
    }
  } catch (err) {
    console.warn('Neo4j query failed, using neutral graph risk:', err.message);
    graphRisk = {
      locationDefaultRate: 0,
      locationFarmerCount: 0,
      socialScore:         0,
      connectedPeers:      0,
      avgRepayRatio:       0,
    };
  }

  // ── 4. Base score ──────────────────────────────────────────────────────────
  const baseScore = computeBaseScore({
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
  });

  // ── 5. No gender adjustment — removed entirely ────────────────────────────
  // v1 had: if (gender === 'female' && score >= 55) adjustedScore = 65
  // This was score manipulation based on a protected attribute.
  // The new design surfaces alternative evidence instead of adjusting scores.
  const adjustedScore = baseScore;

  // ── 6. Tier and top reason ────────────────────────────────────────────────
  const tier   = scoreToTier(adjustedScore);
  const reason = determineTopReason(baseScore, {
    cashflow:      mpesaFeatures,
    weather:       weatherRisk,
    graph:         graphRisk,
    loanHistory,
    communityTies,
  });

  // ── 7. Gaps ────────────────────────────────────────────────────────────────
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

  // ── 8. Points to next tier ─────────────────────────────────────────────────
  const tierThresholds = [75, 60, 45, 0];
  const currentThreshold = tierThresholds[tier - 1] || 0;
  const ptsToNextTier = Math.max(0, currentThreshold - adjustedScore);

  // ── 9. Evidence profile ───────────────────────────────────────────────────
  const evidenceProfile = {
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
  };

  // NOTE: writeFarmerNode and writeEvidenceGraph are called in ussdFlow.js
  // before this function runs. Do not call them here.

  return {
    tier,
    gaps,
    ptsToNextTier,
    evidenceProfile: enrichedEvidence,
    scoredAt: new Date().toISOString(),
  };
}

module.exports = { initiateRiskAssessment };