/**
 * ussdFlow.js — USSD session state machine (kenyan-street-swa version)
 *
 * Africa's Talking sends the full accumulated input on every keypress.
 * `text` looks like: "" → "1" → "1*2" → "1*2*3" etc.
 *
 * We split on '*' and route based on depth + first choice.
 *
 * Flow A — New assessment (text starts with "1"):
 *   1 → crop → productionSize → coop → loan → group → mpesa → gender → confirm → score
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
 */

const { getSession, saveSession, deleteSession, getFarmerRecord, saveFarmerRecord } = require('../db/sessionStore');
const { score, scoreWithNetwork, tierMeta } = require('./scorer');
const { buildSMS, buildUSSDDetail, buildRepaymentLink } = require('./explainer');
const { writeFarmerNode, getNetworkBonus } = require('../db/neo4j');
const { hashPhone } = require('../db/sessionStore');
const { sendSMS } = require('./smsService');

// ── Screen builders (Kenyan-market Swahili) ─────────────────────────────────

const S = {
  main: () =>
    `CON Karibu FarmCredit 🌱\n` +
    `Welcome to FarmCredit\n\n` +
    `1. Pima mkopo wako\n` +
    `2. Matokeo yangu\n` +
    `3. Elimu ya malipo\n` +
    `0. Toka`,

  crop: () =>
    `CON Unalima nini hasa?\n\n` +
    `1. Mahindi\n` +
    `2. Maharagwe\n` +
    `3. Ng'ombe/Maziwa\n` +
    `4. Mboga/Matunda\n` +
    `5. Mchanganyiko`,

  productionSize: () =>
  `CON Ukubwa wa uzalishaji wako?\n\n` +
  `1. Mdogo\n` +
  `2. Wastani\n` +
  `3. Mkubwa`,



  coop: () =>
    `CON Uko kwenye ushirika wa kilimo?\n\n` +
    `1. Ndio, miaka 2+ (active)\n` +
    `2. Ndio, chini ya miaka 2\n` +
    `3. Ndio, lakini sio active\n` +
    `4. Hapana`,

  loan: () =>
    `CON Umewahi kupata mkopo?\n\n` +
    `1. Ndio, nimelipa yote\n` +
    `2. Ndio, nimelipa sehemu\n` +
    `3. Ndio, sikulipa\n` +
    `4. Mkopo wa chama nililipa\n` +
    `5. Hapana, huu ni wa kwanza`,

  group: () =>
    `CON Uko kwenye chama cha akiba?\n\n` +
    `1. Ndio, nachangia kila wakati\n` +
    `2. Ndio, wakati mwingine\n` +
    `3. Hapana`,

  mpesa: () =>
    `CON Unatumia M-Pesa aje?\n\n` +
    `1. Kila siku\n` +
    `2. Kila wiki\n` +
    `3. Kila mwezi\n` +
    `4. Mara chache`,

  gender: () =>
    `CON Swali la mwisho: Jinsia?\n\n` +
    `1. Mwanamke\n` +
    `2. Mwanaume\n` +
    `3. Sitaki kusema`,

  confirm: (answers) => {

return `CON Hakikisha:\n\n` +

`Zao: ${cropLabel(answers.crop)}\n` +

`Uzalishaji: ${answers.productionSize}\n` +

`Ushirika: ${coopLabel(answers.coop)}\n` +

`Mkopo: ${loanLabel(answers.loan)}\n\n` +

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

// ── Label helpers (confirm screen) ───────────────────────────────────────────

const cropLabel = c => ({
  maize:'Mahindi',
  beans:'Maharagwe',
  dairy:'Maziwa',
  horticulture:'Mboga',
  mixed:'Mchanganyiko'
}[c] || '?');

const coopLabel     = c => ({ '1':'Miaka 2+','2':'<Miaka 2','3':'Sio active','4':'Hapana' }[c] || '?');
const loanLabel     = l => ({ '1':'Nililipa yote','2':'Nililipa sehemu','3':'Sikulipa','4':'Mkopo wa chama','5':'Mkopo wa kwanza' }[l] || '?');

// ── Answer maps → scorer keys ─────────────────────────────────────────────────

const CROP_MAP     = { '1':'maize','2':'beans','3':'dairy','4':'horticulture','5':'mixed' };


const COOP_MAP     = { '1':'active_over2yr','2':'active_under2yr','3':'inactive','4':'none' };    // general coop / milk coop
const LOAN_MAP     = { '1':'repaid_full','2':'repaid_partial','3':'defaulted','4':'repaid_chama','5':'no_prior' };
const GROUP_MAP    = { '1':'active_saving','2':'occasional','3':'none' };
const MPESA_MAP    = { '1':'daily','2':'weekly','3':'monthly','4':'rarely' };
const GENDER_MAP   = { '1':'female','2':'male','3':'unspecified' };


const PRODUCTION_MAP = {
  '1':'small',
  '2':'medium',
  '3':'large'
};

// ── Question sequences per crop ──────────────────────────────────────────────

const SEQUENCES = {
  default: [
    'productionSize',
    'coop',
    'loan',
    'group',
    'mpesa',
    'gender'
  ]
};
// ── Next question screen based on key ────────────────────────────────────────

function screenForKey(key) {

  const screens = {

    productionSize: S.productionSize,

    coop: S.coop,

    loan: S.loan,

    group: S.group,

    mpesa: S.mpesa,

    gender: S.gender

  };

  return (screens[key] || S.invalid)();

}

// ── Map answer value to scorer key ──────────────────────────────────────────

function mapAnswer(key, value) {
  const maps = {

  productionSize: PRODUCTION_MAP,

  coop: COOP_MAP,

  loan: LOAN_MAP,

  group: GROUP_MAP,

  mpesa: MPESA_MAP,

  gender: GENDER_MAP

};
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
    // Retrieve or create session for this assessment flow
    let session = await getSession(sessionId);
    if (!session || session.state !== 'assess') {
      // Start a fresh assessment
      session = { state: 'assess', answers: {} };
      await saveSession(sessionId, session);
    }

    const answers = session.answers;

    // ── 1st step: crop question ──────────────────────────────────────────────
    if (!answers.crop) {
      if (parts.length < 2) return S.crop();   // waiting for crop answer
      const cropVal = parts[1];
      if (!CROP_MAP[cropVal]) return S.invalid();
      answers.crop = CROP_MAP[cropVal];
      await saveSession(sessionId, session);
      // Show the first question of the sequence for this crop
      const seq = SEQUENCES.default;
      return screenForKey(seq[0]);
    }

    // ── Collect answers using the crop‑specific sequence ─────────────────────
    const seq = SEQUENCES.default;
    // How many sequence answers have we already stored?
    const storedSeqKeys = seq.filter(key => answers.hasOwnProperty(key));

    // If all sequence answers are stored, we are in confirm phase
    if (storedSeqKeys.length === seq.length) {
      // Expect confirm choice
      const lastPart = parts[parts.length - 1];
      if (lastPart === '2') {
        // Start again
        await deleteSession(sessionId);
        return S.main();
      }
      if (lastPart === '0') {
        await deleteSession(sessionId);
        return S.goodbye();
      }
      if (lastPart !== '1') return S.invalid();

      // ── Score the farmer ───────────────────────────────────────────────
      const scorerInput = { crop: answers.crop };
      // Copy all stored answers into scorerInput, using mapped values
      for (const key of seq) {
        scorerInput[key] = answers[key];
      }
      // Add gender (always present)
      scorerInput.gender = answers.gender;

      const baseResult = score(scorerInput);
      const phoneHash = hashPhone(phoneNumber);

      // Write farmer node to Neo4j (fire & forget)
      writeFarmerNode({
        phoneHash,
        tier:      baseResult.tier,
        crop:      answers.crop,
        productionSize: answers.productionSize,
        gender:    answers.gender,
        coopName:
          answers.coop !== 'none'
          ? 'Self-reported coop'
          : null,
        hadLoan:   answers.loan !== 'no_prior',
        repaid:    answers.loan === 'repaid_full' || answers.loan === 'repaid_chama',
      }).catch(err => console.warn('Neo4j write failed:', err.message));

      // Network bonus (async)
      const networkData = await getNetworkBonus(phoneHash).catch(() => ({ bonus: 0, reason: null }));
      const networkScore = Math.max(0, Math.min(1000, baseResult.score + networkData.bonus));
      let networkTier;
      if (networkScore >= 640) networkTier = 1;
      else if (networkScore >= 420) networkTier = 2;
      else if (networkScore >= 220) networkTier = 3;
      else networkTier = 4;

      const result = {
        ...baseResult,
        score:         networkScore,
        tier:          networkTier,
        networkBonus:  networkData.bonus,
        networkReason: networkData.reason,
        baseScore:     baseResult.score,
      };

      // Save farmer record
      const existing = await getFarmerRecord(phoneNumber);
      await saveFarmerRecord(phoneNumber, {
        lastScore:        result,
        lastTier:         result.tier,
        lastScoredAt:     result.scoredAt,
        assessmentCount:  (existing?.assessmentCount || 0) + 1,
        pinSet:           existing?.pinSet || false,
        pin:              existing?.pin    || null,
      });

      // Send SMS asynchronously
      const smsText = buildSMS(result);
      sendSMS(phoneNumber, smsText).catch(err =>
        console.error('SMS send failed:', err.message)
      );

      await deleteSession(sessionId);
      return S.processing();
    }

    // ── Still collecting answers ──────────────────────────────────────────────
    // The next expected key is the first key not yet stored
    const nextKey = seq[storedSeqKeys.length];
    if (parts.length < storedSeqKeys.length + 2) {
      // Show the question for nextKey (we are waiting for it)
      return screenForKey(nextKey);
    }

    // We have a new answer (the last part)
    const answerValue = parts[parts.length - 1];
    const map = {
  productionSize: PRODUCTION_MAP,
  coop: COOP_MAP,
  loan: LOAN_MAP,
  group: GROUP_MAP,
  mpesa: MPESA_MAP,
  gender: GENDER_MAP,
};
    const mapped = mapAnswer(nextKey, answerValue);
    if (mapped === undefined) return S.invalid();
    answers[nextKey] = mapped;
    await saveSession(sessionId, session);

    // After storing, check if we just collected the last sequence key
    const newStoredLen = seq.filter(k => answers.hasOwnProperty(k)).length;
    if (newStoredLen === seq.length) {
      // All sequence answers collected – show confirm screen
      return S.confirm(answers);
    }
    // Otherwise, show the next question
    return screenForKey(seq[newStoredLen]);
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
          pin:    parts[2],
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