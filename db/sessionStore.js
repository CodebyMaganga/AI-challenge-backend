/**
 * sessionStore.js
 *
 * One MongoDB collection handles two record types:
 *
 *  1. LIVE SESSION  — keyed by AT sessionId, TTL 10 min
 *     Holds the in-progress USSD answers while the farmer is on the line.
 *
 *  2. FARMER RECORD — keyed by phoneNumber (hashed)
 *     Holds the last score, tier, and internal breakdown.
 *     The farmer never sees the raw breakdown — only the explainer output.
 *
 * Why hash the phone number?
 *   If the database is ever exposed, a hash prevents direct identification
 *   of the farmer's number. We use a simple salted hash — good enough for
 *   a prototype; upgrade to bcrypt or a KMS in production.
 */

const mongoose = require('mongoose');
const crypto   = require('crypto');

const SALT = process.env.PHONE_SALT || 'farmcredit_salt_change_in_prod';

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashPhone(phone) {
  return crypto.createHmac('sha256', SALT).update(phone).digest('hex');
}

// ── Schema ────────────────────────────────────────────────────────────────────

const sessionSchema = new mongoose.Schema(
  {
    // Shared fields
    _id:     { type: String }, // sessionId OR 'farmer:<phoneHash>'

    // Live session fields
    state:       String,       // 'assess' while farmer is mid-flow
    phone:       String,
    networkCode: String,
    answers:     { type: Object, default: {} },
    step:        { type: Number, default: 0 },

    // Farmer record fields (persisted after scoring)
    phoneHash:   String,
    pin:         String,
    pinSet:      { type: Boolean, default: false },
    lastScore:   Object,
    lastTier:    Number,
    lastScoredAt: Date,
    assessmentCount: { type: Number, default: 0 },
    lastEvidence: Object,

    // TTL — live sessions expire after 10 minutes automatically
    expiresAt: Date,
  },
  { _id: false }
);

// Sparse TTL index — only documents WITH expiresAt will be auto-deleted
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true });

const Session = mongoose.model('Session', sessionSchema);

// ── Live session API ──────────────────────────────────────────────────────────

async function getSession(sessionId) {
  const doc = await Session.findById(sessionId).lean();
  return doc || null;
}

/**
 * saveSession — always uses $set so existing fields are never wiped.
 *
 * The old spread approach ({ ...data }) was doing a root-level replace
 * which caused the 'state' field to disappear between requests, triggering
 * the answers reset guard in ussdFlow.js on every subsequent call.
 */
async function saveSession(sessionId, data) {
  // Flatten nested answers object into dot-notation $set keys
  // so MongoDB merges individual answer fields rather than replacing the whole object.
  const setPayload = {
    _id:       sessionId,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  };

  // Copy top-level fields (state, candidatePIN, detailShown, etc.)
  for (const [k, v] of Object.entries(data)) {
    if (k === 'answers') continue; // handled below
    setPayload[k] = v;
  }

  // Merge individual answer keys with dot notation so other answers aren't wiped
  if (data.answers && typeof data.answers === 'object') {
    for (const [k, v] of Object.entries(data.answers)) {
      setPayload[`answers.${k}`] = v;
    }
  }

  return Session.findByIdAndUpdate(
    sessionId,
    { $set: setPayload },
    { upsert: true, new: true }
  );
}

async function deleteSession(sessionId) {
  return Session.findByIdAndDelete(sessionId);
}

// ── Farmer record API ─────────────────────────────────────────────────────────

async function getFarmerRecord(phone) {
  const id = 'farmer:' + hashPhone(phone);
  return Session.findById(id).lean();
}

async function saveFarmerRecord(phone, data) {
  const id = 'farmer:' + hashPhone(phone);
  return Session.findByIdAndUpdate(
    id,
    {
      $set: {
        ...data,
        _id:       id,
        phoneHash: hashPhone(phone),
        // No expiresAt — farmer records persist indefinitely
      },
    },
    { upsert: true, new: true }
  );
}

module.exports = {
  getSession,
  saveSession,
  deleteSession,
  getFarmerRecord,
  saveFarmerRecord,
  hashPhone,
};