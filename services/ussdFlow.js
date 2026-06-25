/**
 * ussdFlow.js — USSD session state machine (updated for risk engine)
 *
 * Africa's Talking sends the full accumulated input on every keypress.
 * `text` looks like: "" → "1" → "1*2" → "1*2*3" etc.
 *
 * We split on '*' and route based on depth + first choice.
 *
 * Flow A — New assessment (text starts with "1"):
 *   1 → consent → location → farmSize → cropType → cropSeason → pastLoan → confirm → score
 *
 * Flow B — View my result (text starts with "2"):
 *   2 → enter PIN → show detail OR set PIN if first time
 *
 * Flow C — Understand repayment (text starts with "3"):
 *   3 → repayment connection message
 *
 * Privacy gate:
 *   The SMS is safe to read by anyone (no sensitive language).
 *   The full USSD detail requires a 4-digit PIN set by the farmer.
 *   If she hasn't set a PIN yet, flow B asks her to create one first.
 *
 * New risk assessment pipeline:
 *   After confirmation, the backend fetches external data (M‑Pesa, weather),
 *   runs Neo4j graph queries, and calculates a final score.
 *   No duplicate calls — scoring is done once.
 */

const { getSession, saveSession, deleteSession, getFarmerRecord, saveFarmerRecord } = require('../db/sessionStore');
const { buildSMS, buildUSSDDetail, buildRepaymentLink } = require('./explainer');
const { writeFarmerNode } = require('../db/neo4j');
const { hashPhone } = require('../db/sessionStore');
const { sendSMS } = require('./smsService');
// Placeholder for the real risk assessment engine
const { initiateRiskAssessment } = require('./riskEngine');

// ── Screen builders (Kenyan-market Swahili) ─────────────────────────────────

const S = {
  main: () =>
    `CON Karibu FarmCredit 🌱\n` +
    `Welcome to FarmCredit\n\n` +
    `1. Pima mkopo wako\n` +
    `2. Matokeo yangu\n` +
    `3. Elimu ya malipo\n` +
    `0. Toka`,

  // New consent screen
  mpesaConsent: () =>
    `CON Tunaweza kuangalia taarifa za M-Pesa yako?\n` +
    `Hii itatusaidia kujua uwezo wako wa mkopo.\n\n` +
    `1. Ndio, nina ruhusa\n` +
    `2. Hapana`,

  // New location screen (simplified — you may extend with more counties)
  location: () =>
    `CON Shamba lako liko kaunti gani?\n\n` +
    `1. Kiambu\n` +
    `2. Murang'a\n` +
    `3. Machakos\n` +
    `4. Nakuru\n` +
    `5. Ingiza jina la kaunti`,

  farmSize: () =>
    `CON Ukubwa wa shamba lako ni eka ngapi?\n\n` +
    `1. Chini ya 0.5\n` +
    `2. 0.5 - 2\n` +
    `3. 2 - 5\n` +
    `4. 5 - 10\n` +
    `5. Zaidi ya 10`,

  cropType: () =>
    `CON Unalima nini hasa?\n\n` +
    `1. Mahindi\n` +
    `2. Maharagwe\n` +
    `3. Ng'ombe/Maziwa\n` +
    `4. Mboga/Matunda\n` +
    `5. Mchanganyiko`,

  cropSeason: () =>
    `CON Unapanda msimu gani?\n\n` +
    `1. Masika (March-May)\n` +
    `2. Vuli (Oct-Dec)\n` +
    `3. Kilimo cha mwaka mzima`,

  pastLoan: () =>
    `CON Umewahi kupata mkopo?\n\n` +
    `1. Ndio, nimelipa yote\n` +
    `2. Ndio, nimelipa sehemu\n` +
    `3. Ndio, sikulipa\n` +
    `4. Mkopo wa chama nililipa\n` +
    `5. Hapana, huu ni wa kwanza`,

  gender: () =>
  `CON Swali la mwisho: Jinsia?\n\n` +
  `1. Mwanamke\n` +
  `2. Mwanaume\n` +
  `3. Sitaki kusema`,

  confirm: (answers) => {
    return `CON Hakikisha:\n\n` +
      `Ruhusa M-Pesa: ${answers.mpesaConsent ? 'Ndio' : 'Hapana'}\n` +
      `Kaunti: ${answers.location}\n` +
      `Shamba: ${answers.farmSize}\n` +
      `Zao: ${answers.cropType}\n` +
      `Msimu: ${answers.cropSeason}\n` +
      `Mkopo uliopita: ${pastLoanLabel(answers.pastLoan)}\n\n` +
      `1. Hakikisha, pata matokeo\n` +
      `2. Anza upya\n` +
      `0. Toka`;
  },

  processing: () =>
    `END Asante! Tunakutumia matokeo kwa SMS.\n` +
    `Utapokea ujumbe ndani ya dakika 1.\n\n` +
    `Piga *384# tena kwa maelezo zaidi.`,

  setPIN: () =>
    `CON Weka PIN yako ya siri (namba 4)\n` +
    `ili kulinda matokeo yako:\n\n` +
    `Ingiza namba 4:`,

  confirmPIN: () =>
    `CON Ingiza PIN tena kuthibitisha:`,

  pinMismatch: () =>
    `CON PIN hazifanani. Jaribu tena.\n` +
    `Ingiza namba 4:`,

  enterPIN: () =>
    `CON Ingiza PIN yako (namba 4) kuona matokeo:`,

  wrongPIN: () =>
    `CON PIN si sahihi. Jaribu tena.\n` +
    `Ingiza PIN yako:`,

  noResult: () =>
    `END Hatuna matokeo yako bado.\n` +
    `Piga *384# chagua 1 kupima mkopo.`,

  invalid: () =>
    `CON Chaguo si sahihi. Jaribu tena.\n` +
    `0. Rudi`,

  goodbye: () =>
    `END Asante. Karibu tena!\nFarmCredit 🌱`,
};

// ── Label helpers ───────────────────────────────────────────────────────────

const pastLoanLabel = (l) => ({
  'repaid_full': 'Nimelipa yote',
  'repaid_partial': 'Nimelipa sehemu',
  'defaulted': 'Sikulipa',
  'repaid_chama': 'Mkopo wa chama',
  'no_prior': 'Mkopo wa kwanza'
}[l] || '?');

// ── Answer maps → scorer keys ─────────────────────────────────────────────────

const MPESA_CONSENT_MAP = { '1': true, '2': false };
const LOCATION_MAP = {
  '1': 'kiambu',
  '2': 'muranga',
  '3': 'machakos',
  '4': 'nakuru',
  // '5' will be handled as free text later
};
const FARM_SIZE_MAP = { '1': '<0.5', '2': '0.5-2', '3': '2-5', '4': '5-10', '5': '>10' };
const CROP_TYPE_MAP = { '1': 'maize', '2': 'beans', '3': 'dairy', '4': 'horticulture', '5': 'mixed' };
const CROP_SEASON_MAP = { '1': 'long_rains', '2': 'short_rains', '3': 'year_round' };
const PAST_LOAN_MAP = {
  '1': 'repaid_full',
  '2': 'repaid_partial',
  '3': 'defaulted',
  '4': 'repaid_chama',
  '5': 'no_prior',
};
const GENDER_MAP = { '1': 'female', '2': 'male', '3': 'unspecified' };

// ── New fixed sequence (no branching) ─────────────────────────────────────────
const SEQUENCE = [
  'mpesaConsent',
  'location',
  'farmSize',
  'cropType',
  'cropSeason',
  'pastLoan',
  'gender', 
];

// ── Next question screen based on key ────────────────────────────────────────
function screenForKey(key) {
  const screens = {
    mpesaConsent: S.mpesaConsent,
    location: S.location,
    farmSize: S.farmSize,
    cropType: S.cropType,
    cropSeason: S.cropSeason,
    pastLoan: S.pastLoan,
  };
  return screens[key] ? screens[key]() : S.invalid();
}

// ── Map answer value to scorer key ──────────────────────────────────────────
function mapAnswer(key, value) {
  const maps = {
    mpesaConsent: MPESA_CONSENT_MAP,
    location: LOCATION_MAP,       // fallback handled separately for '5'
    farmSize: FARM_SIZE_MAP,
    cropType: CROP_TYPE_MAP,
    cropSeason: CROP_SEASON_MAP,
    pastLoan: PAST_LOAN_MAP,
    gender: GENDER_MAP,
  };
  if (key === 'location' && value === '5') {
    // The next screen will capture the name as text — but for simplicity we'll treat it as is.
    return 'free_text'; // will be replaced when free text is entered
  }
  return (maps[key] && maps[key][value]) || value;
}

// ── Main handler ─────────────────────────────────────────────────────────────

async function handleUSSD({ sessionId, phoneNumber, text, networkCode }) {
  const parts = text === '' ? [] : text.split('*');
  const mainChoice = parts[0];

  // Main menu
  if (parts.length === 0) return S.main();

  // Exit from top-level only
  if (mainChoice === '0') {
    await deleteSession(sessionId);
    return S.goodbye();
  }

  // ══ FLOW A: New assessment ════════════════════════════════════════════════
  if (mainChoice === '1') {
    let session = await getSession(sessionId);
    if (!session || session.state !== 'assess') {
      session = { state: 'assess', answers: {} };
      await saveSession(sessionId, session);
    }

    const answers = session.answers;
    const storedKeys = SEQUENCE.filter(k => answers.hasOwnProperty(k));

    // If we haven't collected all answers, keep asking
    if (storedKeys.length < SEQUENCE.length) {
      const nextKey = SEQUENCE[storedKeys.length];
      // If this is the first question and we are at the right depth
      if (parts.length === 1 && storedKeys.length === 0) {
        // Show first question (consent)
        return screenForKey(nextKey);
      }

      // For subsequent answers: parts[0]='1', then answers come in order.
      // The answer we need is at index = storedKeys.length + 1? Wait.
      // The first answer (consent) is at parts[1], second at parts[2], etc.
      // Because parts = ['1', answer1, answer2, ...]
      const answerIndex = storedKeys.length + 1;
      if (parts.length <= answerIndex) {
        // Still waiting for input for the current question
        return screenForKey(nextKey);
      }

      // We have an answer value
      const rawValue = parts[answerIndex];
      let mapped = mapAnswer(nextKey, rawValue);

      // Special handling for free-text location (option 5)
      if (nextKey === 'location' && rawValue === '5') {
        // Expect the next part to be the text; we'll treat it as a special case
        // For simplicity, we'll allow a two-step location: first select 5, then enter name.
        if (parts.length === answerIndex + 1) {
          // Wait for the free text (this would be a separate screen)
          // We need a helper to ask for text. We'll define a locationText screen.
          return `CON Ingiza jina la kaunti yako:`;
        }
        // When the user enters the text, it will be in the next part
        // We'll treat it as a direct answer for location
        // So we need to adjust: after selecting 5, the next input becomes the location.
        // This complicates the flow. To avoid complexity, I'll restrict to predefined counties for now.
        // If you absolutely need free text, a different state machine logic is required.
        // For this draft, we'll just map '5' to 'other'.
        mapped = 'other'; // fallback
      }

      if (mapped === undefined) return S.invalid();

      answers[nextKey] = mapped;
      await saveSession(sessionId, session);

      // After answering, check if we are done
      const newStoredLen = SEQUENCE.filter(k => answers.hasOwnProperty(k)).length;
      if (newStoredLen === SEQUENCE.length) {
        return S.confirm(answers);
      }
      // Show next question
      return screenForKey(SEQUENCE[newStoredLen]);
    }

    // All answers collected, now handle confirm screen options
    const lastPart = parts[parts.length - 1];

    if (lastPart === '2') {
      // Start over
      await deleteSession(sessionId);
      return S.main();
    }

    if (lastPart === '0') {
      await deleteSession(sessionId);
      return S.goodbye();
    }

    if (lastPart !== '1') {
      return S.invalid();
    }

    // ── User confirmed → run risk assessment ──────────────────────────────
    const applicationData = {
      phone: phoneNumber,
      consent: answers.mpesaConsent,
      location: answers.location,
      farmSize: answers.farmSize,
      cropType: answers.cropType,
      cropSeason: answers.cropSeason,
      pastLoan: answers.pastLoan,
      gender: answers.gender,
    };

    const phoneHash = hashPhone(phoneNumber);

    // Write farmer node to Neo4j (async) — basic identity
    writeFarmerNode({
      phoneHash,
      tier: null,
      crop: answers.cropType,
      land: answers.farmSize,
      gender: null, // no longer collected; you can add if needed
      location: answers.location,
    }).catch(err => console.warn('Neo4j write failed:', err.message));

    // Call the external risk engine (fetches M‑Pesa, weather, graph)
    const result = await initiateRiskAssessment(applicationData, phoneHash);

    // Save farmer record in MongoDB for later retrieval
    const existing = await getFarmerRecord(phoneNumber);
    await saveFarmerRecord(phoneNumber, {
      lastScore: result,
      lastTier: result.tier,
      lastScoredAt: result.scoredAt,
      assessmentCount: (existing?.assessmentCount || 0) + 1,
      pinSet: existing?.pinSet || false,
      pin: existing?.pin || null,
      lastEvidence: result.evidenceProfile || null,
    });

    // Send SMS asynchronously
    const smsText = buildSMS(result);
    console.log('📱 SMS CONTENT:', smsText);
    sendSMS(phoneNumber, smsText).catch(err =>
      console.error('SMS send failed:', err.message)
    );

    await deleteSession(sessionId);
    return S.processing();
  }

  // ══ FLOW B: View my result (PIN-gated) ═══════════════════════════════════
  if (mainChoice === '2') {
    const farmerRecord = await getFarmerRecord(phoneNumber);
    if (!farmerRecord?.lastScore) return S.noResult();

    const fd = parts.length - 1;

    // Sub-flow B1: farmer has no PIN yet → set one first
    if (!farmerRecord.pinSet) {
      if (fd === 0) return S.setPIN();
      if (fd === 1) {
        if (!/^\d{4}$/.test(parts[1])) {
          return `CON PIN lazima iwe namba 4.\nJaribu tena:`;
        }
        await saveSession(sessionId, { candidatePIN: parts[1] });
        return S.confirmPIN();
      }
      if (fd === 2) {
        const sess = await getSession(sessionId);
        if (parts[2] !== sess?.candidatePIN) {
          await deleteSession(sessionId);
          return S.pinMismatch();
        }
        await saveFarmerRecord(phoneNumber, {
          ...farmerRecord,
          pin: parts[2],
          pinSet: true,
        });
        await deleteSession(sessionId);
        const detail = buildUSSDDetail(farmerRecord.lastScore);
        return `CON ${detail}\n\n0. Toka`;
      }
    }

    // Sub-flow B2: farmer has PIN → verify then show detail
    if (fd === 0) return S.enterPIN();
    if (fd === 1) {
      if (parts[1] !== farmerRecord.pin) return S.wrongPIN();
      const detail = buildUSSDDetail(farmerRecord.lastScore);
      await saveSession(sessionId, { detailShown: true });
      return `CON ${detail}\n\n1. Elimu ya malipo\n0. Toka`;
    }
    if (fd === 2 && parts[2] === '1') {
      return buildRepaymentLink(farmerRecord.lastTier);
    }
    if (fd === 2 && parts[2] === '0') {
      await deleteSession(sessionId);
      return S.goodbye();
    }
    return S.invalid();
  }

  // ══ FLOW C: Repayment & credit education ══════════════════════════════════
  if (mainChoice === '3') {
    const farmerRecord = await getFarmerRecord(phoneNumber);
    const tier = farmerRecord?.lastTier || 4;
    return buildRepaymentLink(tier);
  }

  return S.invalid();
}

module.exports = { handleUSSD };