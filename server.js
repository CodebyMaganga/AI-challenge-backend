require('dotenv').config();
const express    = require('express');
const bodyParser = require('body-parser');
const mongoose   = require('mongoose');

const { initSchema } = require('./db/neo4j');
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

// ── USSD route ────────────────────────────────────────────────────────────────
app.use('/ussd', require('./routes/ussd'));

// ── Start server immediately — don't wait for MongoDB ────────────────────────
// This way /ussd responds even if DB is slow to connect.
app.listen(PORT, () => console.log(`🌱 FarmCredit running on http://localhost:${PORT}`));

// ── MongoDB (connect in background) ──────────────────────────────────────────
if (process.env.MONGO_URI) {
  mongoose
    .connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('⚠️  MongoDB failed (sessions will not persist):', err.message));
} else {
  console.warn('⚠️  No MONGO_URI set — running without database');
}

module.exports = app;