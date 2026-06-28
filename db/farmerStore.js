// db/farmerStore.js
/**
 * farmerStore.js — farmer record persistence and dashboard queries.
 *
 * This is separate from sessionStore.js which handles live USSD sessions.
 * sessionStore.js still saves farmer records for USSD PIN/result retrieval.
 * This file saves to the dedicated Farmer collection for dashboard use.
 *
 * Call saveFarmerAssessment from riskEngine.js after scoring completes.
 * The dashboard routes in routes/dashboard.js import the query functions here.
 */

const Farmer = require('./farmerModel');

// ── Write ──────────────────────────────────────────────────────────────────────

/**
 * Save or update a farmer's assessment record.
 * Called from riskEngine.js after initiateRiskAssessment completes.
 *
 * On first assessment: creates the farmer document.
 * On repeat assessment: updates current fields, pushes old score to history.
 *
 * @param {string} phoneHash
 * @param {object} appData     — the full applicationData from ussdFlow.js
 * @param {object} result      — the return value of initiateRiskAssessment
 */
async function saveFarmerAssessment(phoneHash, appData, result) {
  console.log('───────────────────────────────────────');
  console.log('💾 saveFarmerAssessment START');
  console.log('   phoneHash:', phoneHash);
  console.log('   result.tier:', result.tier);
  console.log('   result.scoredAt:', result.scoredAt);
  console.log('   result.evidenceProfile exists:', !!result.evidenceProfile);
  console.log('   result.evidenceProfile.factors exists:', !!result.evidenceProfile?.factors);
  console.log('   result.evidenceProfile.adjustedScore:', result.evidenceProfile?.adjustedScore);
  console.log('   result.evidenceProfile.topReason:', result.evidenceProfile?.topReason);

  const {
    location, farmAccess, leaseLength, cropType, herdSize,
    milkCooperative, farmSeason, communityTies, loanHistory,
    inputAccess, consent, adaptiveBranches,
  } = appData;

  const { tier, gaps, ptsToNextTier, scoredAt } = result;

  const ep      = result.evidenceProfile || {};
  const factors = ep.factors || {};

  console.log('💾 factors.adjustedScore:', factors.adjustedScore);
  console.log('💾 factors.baseScore:', factors.baseScore);
  console.log('💾 factors.topReason:', factors.topReason);
  console.log('💾 ep.found:', ep.found);

  const assessmentSnapshot = {
    scoredAt:      new Date(scoredAt),
    tier,
    baseScore:     factors.baseScore     ?? null,
    adjustedScore: factors.adjustedScore ?? null,
    topReason:     factors.topReason     ?? null,
    gaps,
    ptsToNextTier,
    answers: {
      farmAccess,
      leaseLength:     leaseLength     || null,
      cropType,
      herdSize:        herdSize        || null,
      milkCooperative: milkCooperative || null,
      farmSeason:      farmSeason      || null,
      communityTies,
      loanHistory:     loanHistory     || null,
      inputAccess,
      consentGiven:    !!consent,
    },
    evidence: {
      mpesaScore:        factors.mpesa?.score      ?? null,
      weatherScore:      factors.weather?.score    ?? null,
      graphSocialScore:  factors.graph?.socialScore ?? null,
      coopRepayRate:     ep.coopRepayRate           ?? null,
      goodNeighbors:     ep.goodNeighbors           ?? 0,
      secondDegreeLinks: ep.secondDegreeLinks       ?? 0,
      networkFound:      ep.found                   ?? false,
    },
    adaptiveBranches: adaptiveBranches || {},
  };

  console.log('💾 currentScore being saved:', factors.adjustedScore ?? null);
  console.log('💾 currentTier being saved:', tier);

  try {
    const saved = await Farmer.findOneAndUpdate(
      { phoneHash },
      {
        $set: {
          phoneHash,
          location,
          cropType,
          farmAccess,
          communityTies,
          currentTier:      tier,
          currentScore:     factors.adjustedScore ?? null,
          currentTopReason: factors.topReason     ?? null,
          lastScoredAt:     new Date(scoredAt),
        },
        $inc:  { assessmentCount: 1 },
        $push: {
          assessmentHistory: {
            $each:     [assessmentSnapshot],
            $slice:    -10,
            $position: 0,
          },
        },
      },
      { upsert: true, new: true }
    );
    console.log('💾 ✅ Saved to farmers collection');
    console.log('   saved.currentScore:', saved.currentScore);
    console.log('   saved.currentTier:', saved.currentTier);
    console.log('───────────────────────────────────────');
  } catch (err) {
    console.error('💾 ❌ farmerStore.saveFarmerAssessment failed:', err.message);
    console.error(err);
  }
}

// ── Dashboard queries ──────────────────────────────────────────────────────────

/**
 * List farmers for the dashboard table.
 *
 * Supports filtering by: location, tier, communityTies, cropType, dateRange.
 * Supports sorting by: lastScoredAt, currentScore, currentTier.
 * Supports pagination.
 *
 * Returns sanitised records — no PIN, no raw phone number.
 */
async function listFarmers({
  location,
  tier,
  communityTies,
  cropType,
  dateFrom,
  dateTo,
  sortBy    = 'lastScoredAt',
  sortDir   = 'desc',
  page      = 1,
  limit     = 20,
} = {}) {
  const filter = {};

  if (location)      filter.location      = location;
  if (tier)          filter.currentTier   = Number(tier);
  if (communityTies) filter.communityTies = communityTies;
  if(cropType)
 filter["cropType.crops"] = cropType;

  if (dateFrom || dateTo) {
    filter.lastScoredAt = {};
    if (dateFrom) filter.lastScoredAt.$gte = new Date(dateFrom);
    if (dateTo)   filter.lastScoredAt.$lte = new Date(dateTo);
  }

  const sortField = ['lastScoredAt', 'currentScore', 'currentTier', 'assessmentCount']
    .includes(sortBy) ? sortBy : 'lastScoredAt';
  const sort = { [sortField]: sortDir === 'asc' ? 1 : -1 };

  const skip  = (Math.max(1, page) - 1) * limit;
  const total = await Farmer.countDocuments(filter);

  const farmers = await Farmer.find(filter)
    .select('-assessmentHistory -__v')   // exclude history for list view
    .sort(sort)
    .skip(skip)
    .limit(limit)
    .lean();

  return {
    total,
    page,
    pages: Math.ceil(total / limit),
    farmers,
  };
}

/**
 * Get a single farmer's full record including assessment history.
 * Used for the field officer detail view.
 */
async function getFarmerDetail(phoneHash) {
  return Farmer.findOne({ phoneHash }).lean();
}

/**
 * Dashboard summary stats — counts and breakdowns for the overview panel.
 */
async function getDashboardStats({ location, dateFrom, dateTo } = {}) {
  const matchStage = {};
  if (location) matchStage.location = location;
  if (dateFrom || dateTo) {
    matchStage.lastScoredAt = {};
    if (dateFrom) matchStage.lastScoredAt.$gte = new Date(dateFrom);
    if (dateTo)   matchStage.lastScoredAt.$lte = new Date(dateTo);
  }

  const [tierBreakdown, communityBreakdown, cropBreakdown, totalResult] = await Promise.all([
    // Tier distribution
    Farmer.aggregate([
      { $match: matchStage },
      { $group: { _id: '$currentTier', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),

    // Community ties distribution
    Farmer.aggregate([
      { $match: matchStage },
      { $group: { _id: '$communityTies', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),

    // Crop type distribution
    Farmer.aggregate([
      { $match: matchStage },
      { $unwind: "$cropType.crops" },
      {$group:{
 _id:"$cropType.crops",
 count:{
   $sum:1
 }
}},
      { $sort: { count: -1 } },
    ]),

    // Total farmers
    Farmer.countDocuments(matchStage),
  ]);

  // Tier labels
  const tierLabels = { 1: 'Gold', 2: 'Silver', 3: 'Bronze', 4: 'Decline' };

  return {
    totalFarmers: totalResult,
    tierBreakdown: tierBreakdown.map(t => ({
      tier:  t._id,
      label: tierLabels[t._id] || 'Unknown',
      count: t.count,
    })),
    communityBreakdown: communityBreakdown.map(c => ({
      type:  c._id || 'none',
      count: c.count,
    })),
    cropBreakdown: cropBreakdown.map(c => ({
      cropType: c._id || 'unknown',
      count:    c.count,
    })),
  };
}

/**
 * Location summary — for a field officer covering a specific county.
 * Returns per-county tier breakdown and average scores.
 */
async function getLocationSummary() {
  return Farmer.aggregate([
    {
      $group: {
        _id:          '$location',
        totalFarmers: { $sum: 1 },
        avgScore:     { $avg: '$currentScore' },
        tier1Count:   { $sum: { $cond: [{ $eq: ['$currentTier', 1] }, 1, 0] } },
        tier2Count:   { $sum: { $cond: [{ $eq: ['$currentTier', 2] }, 1, 0] } },
        tier3Count:   { $sum: { $cond: [{ $eq: ['$currentTier', 3] }, 1, 0] } },
        tier4Count:   { $sum: { $cond: [{ $eq: ['$currentTier', 4] }, 1, 0] } },
      },
    },
    { $sort: { totalFarmers: -1 } },
  ]);
}

/**
 * Export farmers as a flat array for CSV download.
 * Field officers use this for offline review and loan committee prep.
 * Returns only the fields needed — no internal IDs.
 */
async function exportFarmers({ location, tier, communityTies, cropType } = {}) {
  const filter = {};
  if (location)      filter.location      = location;
  if (tier)          filter.currentTier   = Number(tier);
  if (communityTies) filter.communityTies = communityTies;
  if(cropType)
 filter["cropType.crops"] = cropType;

  const farmers = await Farmer.find(filter)
    .select('phoneHash location cropType farmAccess communityTies currentTier currentScore currentTopReason lastScoredAt assessmentCount')
    .lean();

  return farmers.map(f => ({
    id:             f.phoneHash.slice(0, 12) + '...',   // truncated for display
    location:       f.location,
    cropType:       f.cropType,
    farmAccess:     f.farmAccess,
    communityTies:  f.communityTies,
    tier:           f.currentTier,
    score:          f.currentScore,
    topReason:      f.currentTopReason,
    lastAssessed:   f.lastScoredAt,
    totalAssessments: f.assessmentCount,
  }));
}

module.exports = {
  saveFarmerAssessment,
  listFarmers,
  getFarmerDetail,
  getDashboardStats,
  getLocationSummary,
  exportFarmers,
};