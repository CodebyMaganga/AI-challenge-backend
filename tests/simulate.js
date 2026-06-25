/**
 * simulate.js — run with: npm test
 *
 * Simulates the Africa's Talking USSD webhook locally.
 * Runs three full journeys through the new loan assessment flow.
 *
 * No real phone or AT account needed — just MongoDB.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { handleUSSD } = require('../services/ussdFlow');

const SEP = '─'.repeat(55);

async function journey(name, phone, inputs) {
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`JOURNEY: ${name}  (${phone})`);
  console.log('═'.repeat(55));

  const sessionId = `sim-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let text = '';

  for (const input of inputs) {
    const response = await handleUSSD({ sessionId, phoneNumber: phone, text, networkCode: '63902' });
    const isEnd = response.startsWith('END');

    console.log(`\n${SEP}`);
    console.log(`► Input: "${input === '' ? '(dial)' : input}"`);
    console.log(`► Accumulated text: "${text}"`);
    console.log(SEP);
    console.log(response.replace(/^(CON|END) /, ''));

    if (isEnd) break;
    text = text === '' ? input : `${text}*${input}`;
  }
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected\n');

  // ── Journey 1: Grace — strong profile (dairy, year‑round) ─────────────────
  await journey('Grace (Tier 1 — strong profile)', '+254700000001', [
    '',     // dial → main menu
    '1',    // 1. Apply for loan
    '1',    // consent: Ndio
    '1',    // location: Kiambu
    '3',    // farm size: 2‑5 acres
    '3',    // crop type: Dairy
    '3',    // crop season: year‑round
    '1',    // past loan: fully repaid
    '1',    // gender: female
    '1',    // confirm → score + SMS
  ]);

  // ── Journey 2: Amina — thin file, no prior loan ────────────────────────────
  await journey('Amina (Tier 3 — thin file)', '+254700000002', [
    '',     // dial
    '1',    // assessment
    '1',    // consent: Ndio
    '3',    // location: Machakos
    '1',    // farm size: under 0.5 acres
    '4',    // crop type: horticulture
    '1',    // crop season: long rains
    '5',    // past loan: no prior
    '1',    // gender: female
    '1',    // confirm
  ]);

  // ── Journey 3: Grace views her result with PIN ─────────────────────────────
  await journey('Grace — view result with PIN', '+254700000001', [
    '',     // dial
    '2',    // view my result
    '1234', // PIN (set on first access, after journey 1 she has it)
    '1',    // see repayment education
  ]);

  await mongoose.disconnect();
  console.log(`\n${'═'.repeat(55)}`);
  console.log('Simulation complete.');
}

run().catch(err => { console.error(err); process.exit(1); });