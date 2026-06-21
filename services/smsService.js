/**
 * smsService.js
 *
 * Thin wrapper around the Africa's Talking SMS API.
 * Called async after scoring — never blocks the USSD response.
 *
 * In sandbox mode: SMS appears in the AT simulator dashboard.
 * In production: delivered to real phone numbers.
 */

const AfricasTalking = require('africastalking');

let smsClient = null;

function getClient() {
  if (!smsClient) {
    const AT = AfricasTalking({
      username: process.env.AT_USERNAME || 'sandbox',
      apiKey:   process.env.AT_API_KEY,
    });
    smsClient = AT.SMS;
  }
  return smsClient;
}

/**
 * Send an SMS to the farmer.
 * @param {string} to      — phone number e.g. "+254712345678"
 * @param {string} message — plain text, max 182 chars for single SMS
 * @returns {Promise}
 */
async function sendSMS(to, message) {
  if (!process.env.AT_API_KEY) {
    // Graceful fallback — log only, don't crash in dev without credentials
    console.log(`[SMS WOULD SEND to ${to}]:\n${message}\n`);
    return;
  }

  try {
    const result = await getClient().send({
      to:   [to],
      from: process.env.SMS_SENDER || 'eSusFarm',
      message,
    });
    console.log(`✅ SMS sent to ${to}:`, result.SMSMessageData?.Message);
    return result;
  } catch (err) {
    console.error(`❌ SMS failed to ${to}:`, err.message);
    throw err;
  }
}

module.exports = { sendSMS };