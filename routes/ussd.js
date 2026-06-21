/**
 * routes/ussd.js
 *
 * Africa's Talking POSTs these fields on every keypress:
 *   sessionId   — unique per call
 *   phoneNumber — farmer's number (e.g. +254712345678)
 *   networkCode — carrier code
 *   serviceCode — USSD code dialled (*384#)
 *   text        — all keypresses joined by '*' (e.g. "1*2*3")
 *
 * We must respond with plain text starting with "CON " or "END ".
 * Timeout is 5 seconds — keep handlers fast.
 */

const express     = require('express');
const router      = express.Router();
const { handleUSSD } = require('../services/ussdFlow');

router.post('/', async (req, res) => {
  const { sessionId, phoneNumber, networkCode, serviceCode, text } = req.body;

  // Validate required fields
  if (!sessionId || !phoneNumber) {
    return res.send('END Hitilafu ya mfumo. Jaribu tena.\nSystem error. Please try again.');
  }

  try {
    const response = await handleUSSD({
      sessionId,
      phoneNumber: phoneNumber.trim(),
      networkCode,
      text: (text || '').trim(),
    });

    // AT expects plain text — no JSON
    res.set('Content-Type', 'text/plain');
    res.send(response);

  } catch (err) {
    console.error('USSD handler error:', err);
    res.send('END Hitilafu ya mfumo. Tafadhali jaribu tena baadaye.\nSystem error. Please try again later.');
  }
});

module.exports = router;