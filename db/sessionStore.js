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
    phone:       String,       // raw phone, only in live session (short TTL)
    networkCode: String,
    answers:     { type: Object, default: {} }, // { crop, land, coop, loan, group, mpesa }
    step:        { type: Number, default: 0 },

    // Farmer record fields (persisted after scoring)
    phoneHash:   String,
    pin:         String,       // 4-digit PIN (plaintext for prototype; hash in prod)
    pinSet:      { type: Boolean, default: false },
    lastScore:   Object,       // internal — lender MIS only
    lastTier:    Number,       // 1–4
    lastScoredAt: Date,
    assessmentCount: { type: Number, default: 0 },

    // TTL — live sessions expire after 10 minutes automatically
    // Farmer records have no TTL (expireAfterSeconds not set on that index)
    expiresAt: Date,
  },
  { _id: false } // we manage _id ourselves
);

// Sparse TTL index — only documents WITH expiresAt will be auto-deleted
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true });

const Session = mongoose.model('Session', sessionSchema);

// ── Live session API ──────────────────────────────────────────────────────────

async function getSession(sessionId) {
  return Session.findById(sessionId).lean();
}

async function saveSession(sessionId, data) {
  return Session.findByIdAndUpdate(
    sessionId,
    {
      ...data,
      _id: sessionId,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 min TTL
    },
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
      ...data,
      _id: id,
      phoneHash: hashPhone(phone),
      // No expiresAt — farmer records persist indefinitely
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
  hashPhone, // exported for seed.js
};