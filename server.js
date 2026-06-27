require('dotenv').config();
const express    = require('express');
const bodyParser = require('body-parser');
const mongoose   = require('mongoose');
const cors = require("cors");

const { initSchema } = require('./db/neo4j');
const app  = express();
app.use(
 cors({
   origin: process.env.FRONTEND_URL,
   credentials:true
 })
);
const PORT = process.env.PORT || 3000;

const dashboardRoutes = require('./routes/dashboard');

// ── Ngrok browser warning bypass ──────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use('/dashboard', dashboardRoutes);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

// ── USSD route ────────────────────────────────────────────────────────────────
app.use('/ussd', require('./routes/ussd'));

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🌱 FarmCredit running on http://localhost:${PORT}`);

  try {
    await initSchema();
    console.log('✅ Neo4j schema ready');
  } catch (e) {
    console.warn('⚠️  Neo4j not configured — network scoring disabled:', e.message);
  }
});

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