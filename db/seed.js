/**
 * seed.js — run with: npm run seed
 *
 * Creates 3 test farmer profiles in MongoDB so you can demo
 * the "View my result" flow without going through USSD each time.
 *
 * Profiles:
 *   +254700000001 — Grace (Tier 1, low risk, active coop)
 *   +254700000002 — Amina (Tier 3, no prior loan, no coop)
 *   +254700000003 — Zawadi (Tier 4, defaulted, rural)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { saveFarmerRecord } = require('./sessionStore');
const { score } = require('../services/scorer');
const { buildSMS } = require('../services/explainer');

const PROFILES = [
  {
    phone: '+254700000001',
    name:  'Grace Achieng',
    answers: {
      crop: 'dairy', land: 'one_three', coop: 'active_over2yr',
      loan: 'repaid_full', group: 'active_saving', mpesa: 'weekly',
      gender: 'female',
    },
  },
  {
    phone: '+254700000002',
    name:  'Amina Wanjiru',
    answers: {
      crop: 'horticulture', land: 'under1', coop: 'none',
      loan: 'no_prior', group: 'occasional', mpesa: 'monthly',
      gender: 'female',
    },
  },
  {
    phone: '+254700000003',
    name:  'Zawadi Otieno',
    answers: {
      crop: 'maize', land: 'under1', coop: 'inactive',
      loan: 'defaulted', group: 'none', mpesa: 'rarely',
      gender: 'female',
    },
  },
];

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB\n');

  for (const p of PROFILES) {
    const result = score(p.answers);
    const smsText = buildSMS(result);

    await saveFarmerRecord(p.phone, {
      lastScore:       result,
      lastTier:        result.tier,
      lastScoredAt:    result.scoredAt,
      assessmentCount: 1,
      pinSet:          true,
      pin:             '1234', // test PIN for all seed profiles
    });

    console.log(`✅ ${p.name} (${p.phone})`);
    console.log(`   Score: ${result.score}/1000 | Tier: ${result.tier} | Gaps: ${result.gaps.map(g=>g.gap).join(', ')}`);
    console.log(`   SMS preview (${smsText.length} chars):`);
    console.log(`   "${smsText}"`);
    console.log();
  }

  await mongoose.disconnect();
  console.log('Seed complete. PIN for all test profiles: 1234');
}

seed().catch(err => { console.error(err); process.exit(1); });