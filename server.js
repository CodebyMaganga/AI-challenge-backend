/**
 * server.js — FarmCredit USSD entry point
 *
 * Africa's Talking POSTs to /ussd on every keypress.
 * We must respond within 5 seconds or AT kills the session.
 * Response must start with "CON " (continue) or "END " (close).
 */

require('dotenv').config();
const express    = require('express');
const bodyParser = require('body-parser');
const mongoose   = require('mongoose');

const ussdRoute  = require('./routes/ussd');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
// Africa's Talking sends application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.post('/ussd', ussdRoute);

// Health check — Railway and Render ping this
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

// ── Database ──────────────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB connected');
    app.listen(PORT, () => console.log(`🌱 FarmCredit USSD running on port ${PORT}`));
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });

module.exports = app; // exported for testing