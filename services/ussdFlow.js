/**
 * ussdFlow.js — USSD session state machine
 *
 * Africa's Talking sends the full accumulated input on every keypress.
 * `text` looks like: "" → "1" → "1*2" → "1*2*3" etc.
 *
 * We split on '*' and route based on depth + first choice.
 *
 * Flow A — New assessment (text starts with "1"):
 *   1 → crop → land → coop → loan → group → mpesa → gender → confirm → score
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
const { score, tierMeta } = require('./scorer');
const { buildSMS, buildUSSDDetail, buildRepaymentLink } = require('./explainer');
const { sendSMS } = require('./smsService');

// ── Screen builders ───────────────────────────────────────────────────────────

const S = {
  main: () =>
    `CON Karibu FarmCredit 🌱\n` +
    `Welcome to FarmCredit\n\n` +
    `1. Tathmini mkopo (Credit check)\n` +
    `2. Angalia matokeo yangu (My result)\n` +
    `3. Malipo na mkopo (Repayment & credit)\n` +
    `0. Toka (Exit)`,

  crop: () =>
    `CON Zao lako kuu ni gani?\n` +
    `What is your main crop?\n\n` +
    `1. Mahindi (Maize)\n` +
    `2. Maharagwe (Beans)\n` +
    `3. Ng'ombe/Maziwa (Dairy)\n` +
    `4. Mboga/Matunda (Horticulture)\n` +
    `5. Mchanganyiko (Mixed)`,

  land: () =>
    `CON Eneo la shamba lako (ekari):\n` +
    `Size of your farm (acres):\n\n` +
    `1. Chini ya ekari 1 (Under 1 acre)\n` +
    `2. Ekari 1 hadi 3 (1–3 acres)\n` +
    `3. Ekari 3 hadi 10 (3–10 acres)\n` +
    `4. Zaidi ya ekari 10 (Over 10 acres)`,

  coop: () =>
    `CON Je, uko katika ushirika wa kilimo?\n` +
    `Are you in a farming cooperative?\n\n` +
    `1. Ndiyo, amilifu zaidi ya miaka 2\n` +
    `   (Yes, active 2+ years)\n` +
    `2. Ndiyo, chini ya miaka 2\n` +
    `   (Yes, active under 2 years)\n` +
    `3. Ndiyo, si amilifu (Yes, inactive)\n` +
    `4. Hapana (No)`,

  loan: () =>
    `CON Je, umewahi kupata mkopo?\n` +
    `Have you had a loan before?\n\n` +
    `1. Ndiyo, nililipa kikamilifu\n` +
    `   (Yes, fully repaid)\n` +
    `2. Ndiyo, nililipa sehemu\n` +
    `   (Yes, partly repaid)\n` +
    `3. Ndiyo, sikuweza kulipa\n` +
    `   (Yes, could not repay)\n` +
    `4. Ndiyo, kulipa kwa chama\n` +
    `   (Yes, repaid a chama loan)\n` +
    `5. Hapana, mkopo wa kwanza\n` +
    `   (No, this is my first)`,

  group: () =>
    `CON Je, uko katika chama cha akiba?\n` +
    `Are you in a savings group (chama)?\n\n` +
    `1. Ndiyo, ninachangia kila wakati\n` +
    `   (Yes, I contribute regularly)\n` +
    `2. Ndiyo, wakati mwingine\n` +
    `   (Yes, sometimes)\n` +
    `3. Hapana (No)`,

  mpesa: () =>
    `CON Unatumia M-Pesa mara ngapi?\n` +
    `How often do you use M-Pesa?\n\n` +
    `1. Kila siku (Daily)\n` +
    `2. Kila wiki (Weekly)\n` +
    `3. Kila mwezi (Monthly)\n` +
    `4. Mara chache (Rarely)`,

  gender: () =>
    `CON Swali la mwisho:\n` +
    `Last question:\n\n` +
    `1. Mwanamke (Female)\n` +
    `2. Mwanaume (Male)\n` +
    `3. Ningependa kutobainisha\n` +
    `   (Prefer not to say)`,

  confirm: (ans) =>
    `CON Thibitisha:\n` +
    `Confirm:\n\n` +
    `Zao: ${cropLabel(ans.crop)} | Shamba: ${landLabel(ans.land)}\n` +
    `Ushirika: ${coopLabel(ans.coop)} | Mkopo: ${loanLabel(ans.loan)}\n\n` +
    `1. Thibitisha na upate matokeo\n` +
    `   (Confirm & get result)\n` +
    `2. Anza upya (Start again)\n` +
    `0. Toka (Exit)`,

  processing: () =>
    `END Asante! Tunakusindikia matokeo kwa SMS.\n` +
    `Thank you! Sending your result by SMS.\n\n` +
    `Utapata ujumbe wako ndani ya dakika 1.\n` +
    `You will receive your message within 1 minute.\n\n` +
    `Piga *384# tena kuona maelezo zaidi.\n` +
    `Dial *384# again to see full details.`,

  setPIN: () =>
    `CON Weka nambari yako ya siri ya tarakimu 4\n` +
    `ili kulinda matokeo yako ya mkopo:\n` +
    `Set a 4-digit secret PIN to protect\n` +
    `your credit result:\n\n` +
    `Ingiza tarakimu 4 (Enter 4 digits):`,

  confirmPIN: () =>
    `CON Ingiza nambari yako ya siri tena\n` +
    `ili kuthibitisha:\n` +
    `Re-enter your PIN to confirm:`,

  pinMismatch: () =>
    `CON Nambari hazikuoana. Jaribu tena.\n` +
    `PINs did not match. Try again.\n\n` +
    `Ingiza nambari yako ya siri (4 digits):`,

  enterPIN: () =>
    `CON Ingiza nambari yako ya siri (tarakimu 4)\n` +
    `kuona maelezo yako:\n` +
    `Enter your 4-digit PIN to view\n` +
    `your full result:`,

  wrongPIN: () =>
    `CON Nambari si sahihi. Jaribu tena.\n` +
    `Incorrect PIN. Try again.\n\n` +
    `Ingiza nambari yako ya siri:`,

  noResult: () =>
    `END Hatujapata tathmini yako bado.\n` +
    `No assessment found yet.\n\n` +
    `Piga *384# uchague 1 kufanya tathmini yako.\n` +
    `Dial *384# and choose 1 to get assessed.`,

  invalid: () =>
    `CON Chaguo si sahihi. Jaribu tena.\n` +
    `Invalid option. Please try again.\n\n` +
    `0. Rudi (Back to main menu)`,

  goodbye: () =>
    `END Asante. Karibu tena!\n` +
    `Thank you. Come back anytime!\n` +
    `FarmCredit 🌱`,
};

// ── Label helpers (for confirm screen) ───────────────────────────────────────

const cropLabel  = c => ({ '1':'Mahindi','2':'Maharagwe','3':'Maziwa','4':'Mboga','5':'Mchanganyiko' }[c] || '?');
const landLabel  = l => ({ '1':'<1 ekari','2':'1–3 ekari','3':'3–10 ekari','4':'>10 ekari' }[l] || '?');
const coopLabel  = c => ({ '1':'Amilifu 2+yr','2':'Amilifu <2yr','3':'Si amilifu','4':'Hapana' }[c] || '?');
const loanLabel  = l => ({ '1':'Nililipa','2':'Sehemu','3':'Sikuweza','4':'Chama','5':'Mkopo wa kwanza' }[l] || '?');

// ── Answer maps → scorer keys ─────────────────────────────────────────────────

const CROP_MAP  = { '1':'maize','2':'beans','3':'dairy','4':'horticulture','5':'mixed' };
const LAND_MAP  = { '1':'under1','2':'one_three','3':'three_ten','4':'over10' };
const COOP_MAP  = { '1':'active_over2yr','2':'active_under2yr','3':'inactive','4':'none' };
const LOAN_MAP  = { '1':'repaid_full','2':'repaid_partial','3':'defaulted','4':'repaid_chama','5':'no_prior' };
const GROUP_MAP = { '1':'active_saving','2':'occasional','3':'none' };
const MPESA_MAP = { '1':'daily','2':'weekly','3':'monthly','4':'rarely' };
const GENDER_MAP= { '1':'female','2':'male','3':'unspecified' };

// ── Main handler ──────────────────────────────────────────────────────────────

async function handleUSSD({ sessionId, phoneNumber, text, networkCode }) {
  const parts = text === '' ? [] : text.split('*');
  const depth = parts.length;

  // ── EXIT anywhere ─────────────────────────────────────────────────────────
  if (parts[parts.length - 1] === '0' && depth > 1) {
    await deleteSession(sessionId);
    return S.goodbye();
  }

  // ── Main menu ─────────────────────────────────────────────────────────────
  if (depth === 0) return S.main();

  const mainChoice = parts[0];

  // ══ FLOW A: New assessment ════════════════════════════════════════════════
  if (mainChoice === '1') {
    const fd = depth - 1; // flow depth (answers given so far within flow A)

    if (fd === 0) return S.crop();
    if (fd === 1) {
      if (!CROP_MAP[parts[1]]) return S.invalid();
      return S.land();
    }
    if (fd === 2) {
      if (!LAND_MAP[parts[2]]) return S.invalid();
      return S.coop();
    }
    if (fd === 3) {
      if (!COOP_MAP[parts[3]]) return S.invalid();
      return S.loan();
    }
    if (fd === 4) {
      if (!LOAN_MAP[parts[4]]) return S.invalid();
      return S.group();
    }
    if (fd === 5) {
      if (!GROUP_MAP[parts[5]]) return S.invalid();
      return S.mpesa();
    }
    if (fd === 6) {
      if (!MPESA_MAP[parts[6]]) return S.invalid();
      return S.gender();
    }
    if (fd === 7) {
      if (!GENDER_MAP[parts[7]]) return S.invalid();
      // Build answers object for confirm screen
      const ans = {
        crop:   parts[1], land: parts[2], coop: parts[3],
        loan:   parts[4], group: parts[5], mpesa: parts[6],
        gender: parts[7],
      };
      return S.confirm(ans);
    }
    if (fd === 8) {
      if (parts[8] === '2') return S.main();         // start again
      if (parts[8] !== '1') return S.invalid();

      // ── Score the farmer ─────────────────────────────────────────────────
      const answers = {
        crop:   CROP_MAP[parts[1]],
        land:   LAND_MAP[parts[2]],
        coop:   COOP_MAP[parts[3]],
        loan:   LOAN_MAP[parts[4]],
        group:  GROUP_MAP[parts[5]],
        mpesa:  MPESA_MAP[parts[6]],
        gender: GENDER_MAP[parts[7]],
      };

      const { score: scoreFn } = require('./scorer');
      const result = scoreFn(answers);

      // Save farmer record (internal — lender MIS)
      const existing = await getFarmerRecord(phoneNumber);
      await saveFarmerRecord(phoneNumber, {
        lastScore:        result,
        lastTier:         result.tier,
        lastScoredAt:     result.scoredAt,
        assessmentCount:  (existing?.assessmentCount || 0) + 1,
        pinSet:           existing?.pinSet || false,
        pin:              existing?.pin    || null,
      });

      // Send SMS asynchronously — don't block USSD response (5s limit)
      const smsText = buildSMS(result);
      sendSMS(phoneNumber, smsText).catch(err =>
        console.error('SMS send failed:', err.message)
      );

      await deleteSession(sessionId);
      return S.processing();
    }
  }

  // ══ FLOW B: View my result (PIN-gated) ═══════════════════════════════════
  if (mainChoice === '2') {
    const farmerRecord = await getFarmerRecord(phoneNumber);

    if (!farmerRecord?.lastScore) return S.noResult();

    const fd = depth - 1;

    // Sub-flow B1: farmer has no PIN yet → set one first
    if (!farmerRecord.pinSet) {
      if (fd === 0) return S.setPIN();
      if (fd === 1) {
        if (!/^\d{4}$/.test(parts[1])) {
          return (
            `CON PIN lazima iwe tarakimu 4.\n` +
            `PIN must be exactly 4 digits.\n\n` +
            `Jaribu tena (Try again):`
          );
        }
        // Store candidate PIN in live session for confirmation
        await saveSession(sessionId, { candidatePIN: parts[1] });
        return S.confirmPIN();
      }
      if (fd === 2) {
        const sess = await getSession(sessionId);
        if (parts[2] !== sess?.candidatePIN) {
          await deleteSession(sessionId);
          return S.pinMismatch();
        }
        // Confirm and save PIN
        await saveFarmerRecord(phoneNumber, {
          ...farmerRecord,
          pin:    parts[2],
          pinSet: true,
        });
        await deleteSession(sessionId);
        const detail = buildUSSDDetail(farmerRecord.lastScore);
        return `CON ${detail}\n\n0. Toka (Exit)`;
      }
    }

    // Sub-flow B2: farmer has PIN → verify then show detail
    if (fd === 0) return S.enterPIN();
    if (fd === 1) {
      if (parts[1] !== farmerRecord.pin) return S.wrongPIN();
      const detail = buildUSSDDetail(farmerRecord.lastScore);
      // Show repayment connection on next screen
      await saveSession(sessionId, { detailShown: true });
      return `CON ${detail}\n\n1. Malipo na mkopo\n   (Repayment & credit)\n0. Toka (Exit)`;
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