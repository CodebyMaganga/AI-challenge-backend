// db/farmerModel.js
/**
 * Farmer — persistent assessment record for dashboard queries.
 *
 * Separate from the Session collection which mixes live USSD sessions
 * and farmer records in one schema. This collection is dashboard-facing:
 * field officers query it, filter it, and export from it.
 *
 * No raw phone numbers stored. phoneHash only.
 * PIN is stored only in the Session collection (USSD retrieval).
 *
 * One document per farmer. Re-assessments update the existing document
 * and push the previous score into assessmentHistory.
 */

const mongoose = require('mongoose');

const assessmentSchema = new mongoose.Schema({
  scoredAt:      { type: Date, required: true },
  tier:          { type: Number, required: true },
  baseScore:     Number,
  adjustedScore: Number,
  topReason:     String,
  gaps:          [{ gap: String }],
  ptsToNextTier: Number,

  // USSD answers snapshot
  answers: {
    farmAccess:      String,
    leaseLength:     String,

  cropType:{
    category:String,
    crops:[String]
  },

    herdSize:        String,
    milkCooperative: String,
    farmSeason:      String,
    communityTies:   String,
    loanHistory:     String,
    inputAccess:     String,
    consentGiven:    Boolean,
  },

  // Evidence signals at time of assessment
  evidence: {
    mpesaScore:        Number,
    weatherScore:      Number,
    graphSocialScore:  Number,
    coopRepayRate:     Number,
    goodNeighbors:     Number,
    secondDegreeLinks: Number,
    networkFound:      Boolean,
  },

  // Which adaptive branches were taken
  adaptiveBranches: {
    wasDairy:           Boolean,
    hasGroupFinance:    Boolean,
    wasLeased:          Boolean,
    loanHistorySkipped: Boolean,
  },
}, { _id: false });

const farmerSchema = new mongoose.Schema({
  phoneHash:  { type: String, required: true, unique: true, index: true },
  location:   { type: String, index: true },
  cropType: {
  category: {
    type: String,
    index: true,
  },

  crops: [{
    type: String
  }]
},
  farmAccess: String,

  // Current (latest) assessment — denormalised for fast dashboard queries
  currentTier:       { type: Number, index: true },
  currentScore:      Number,
  currentTopReason:  String,
  lastScoredAt:      { type: Date, index: true },
  assessmentCount:   { type: Number, default: 1 },

  // Community signal — useful for filtering
  communityTies:     { type: String, index: true },

  // Full history of all assessments
  assessmentHistory: [assessmentSchema],
  // Evidence verification — saved by field officer via dashboard
  evidenceVerification: {
    mpesaStatement: {
      uploaded: { type: Boolean, default: false },
      filename: { type: String, default: null },
    },
    chama: {
      id:       { type: String, default: null },
      name:     { type: String, default: null },
      verified: { type: Boolean, default: false },
    },
    land: {
      type:     { type: String, default: null },  // 'Title Deed'|'Lease Agreement'|'Family Land'
      uploaded: { type: Boolean, default: false },
      filename: { type: String, default: null },
    },
    communityVerification: {
      chamaMembershipVerified:    { type: Boolean, default: false },
      cooperativeMemberVerified:  { type: Boolean, default: false },
      womensGroupLeaderConfirmed: { type: Boolean, default: false },
    },
    notes:      { type: String, default: '' },
    verifiedBy: { type: String, default: null },
    verifiedAt: { type: Date,   default: null },
  },

}, {
  timestamps: true,   // createdAt, updatedAt
  collection: 'farmers',
});

// Compound indexes for common dashboard filters
farmerSchema.index({ location: 1, currentTier: 1 });
farmerSchema.index({ communityTies: 1, currentTier: 1 });
farmerSchema.index({ lastScoredAt: -1 });

module.exports = mongoose.model('Farmer', farmerSchema);