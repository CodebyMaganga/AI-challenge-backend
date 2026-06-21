/**
 * simulate.js — run with: npm test
 *
 * Simulates the Africa's Talking USSD webhook locally.
 * Runs three full journeys and prints every screen.
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

  // Journey 1: Grace — strong profile, full assessment
  await journey('Grace (Tier 1 — strong profile)', '+254700000001', [
    '',     // dial → main menu
    '1',    // → crop
    '3',    // dairy → land
    '2',    // 1–3 acres → coop
    '1',    // active 2+ yrs → loan
    '1',    // fully repaid → group
    '1',    // active saving → mpesa
    '2',    // weekly → gender
    '1',    // female → confirm
    '1',    // confirm → score + SMS
  ]);

  // Journey 2: Amina — thin file, no prior loan, equity adjustment
  await journey('Amina (Tier 3 — thin file)', '+254700000002', [
    '',     // dial
    '1',    // assessment
    '4',    // horticulture
    '1',    // under 1 acre
    '4',    // no coop
    '5',    // no prior loan
    '2',    // chama occasionally
    '3',    // monthly mpesa
    '1',    // female
    '1',    // confirm
  ]);

  // Journey 3: Grace views her result with PIN
  await journey('Grace — view result with PIN', '+254700000001', [
    '',     // dial
    '2',    // view result
    '1234', // PIN
    '1',    // repayment education
  ]);

  await mongoose.disconnect();
  console.log(`\n${'═'.repeat(55)}`);
  console.log('Simulation complete.');
}

run().catch(err => { console.error(err); process.exit(1); });