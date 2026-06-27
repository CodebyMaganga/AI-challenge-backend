// routes/dashboard.js
/**
 * Dashboard API — field officer endpoints.
 *
 * Already mounted at /dashboard in server.js.
 *
 * Endpoints:
 *   GET  /dashboard/stats              — overview counts and breakdowns
 *   GET  /dashboard/farmers            — paginated farmer list with filters
 *   GET  /dashboard/farmers/:phoneHash — single farmer detail + history
 *   GET  /dashboard/locations          — per-county summary
 *   GET  /dashboard/export             — CSV-ready flat array
 *
 * Auth note: these endpoints are currently open.
 * Before production, add middleware that checks a field officer JWT or
 * a static API key set in process.env.DASHBOARD_API_KEY.
 * A simple key check is shown as commented middleware below.
 */

const express = require('express');
const router  = express.Router();
const {
  getDashboardStats,
  listFarmers,
  getFarmerDetail,
  getLocationSummary,
  exportFarmers,
} = require('../db/farmerStore');

// ── Optional API key guard (uncomment when ready) ─────────────────────────────
// const requireKey = (req, res, next) => {
//   const key = req.headers['x-api-key'] || req.query.apiKey;
//   if (key && key === process.env.DASHBOARD_API_KEY) return next();
//   return res.status(401).json({ error: 'Unauthorized' });
// };
// router.use(requireKey);

// ── GET /dashboard/stats ──────────────────────────────────────────────────────
/**
 * Overview panel data.
 * Query params: location, dateFrom, dateTo
 *
 * Response:
 * {
 *   totalFarmers: 142,
 *   tierBreakdown: [{ tier: 1, label: 'Gold', count: 34 }, ...],
 *   communityBreakdown: [{ type: 'chama', count: 89 }, ...],
 *   cropBreakdown: [{ cropType: 'dairy', count: 41 }, ...]
 * }
 */
router.get('/stats', async (req, res) => {
  try {
    const { location, dateFrom, dateTo } = req.query;
    const stats = await getDashboardStats({ location, dateFrom, dateTo });
    res.json(stats);
  } catch (err) {
    console.error('Dashboard /stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── GET /dashboard/farmers ────────────────────────────────────────────────────
/**
 * Paginated farmer list with filters.
 * Query params: location, tier, communityTies, cropType,
 *               dateFrom, dateTo, sortBy, sortDir, page, limit
 *
 * Response:
 * {
 *   total: 142,
 *   page: 1,
 *   pages: 8,
 *   farmers: [{ phoneHash, location, cropType, currentTier, currentScore, ... }]
 * }
 */
router.get('/farmers', async (req, res) => {
  try {
    const {
      location, tier, communityTies, cropType,
      dateFrom, dateTo,
      sortBy, sortDir,
      page  = 1,
      limit = 20,
    } = req.query;

    const result = await listFarmers({
      location, tier, communityTies, cropType,
      dateFrom, dateTo,
      sortBy, sortDir,
      page:  Number(page),
      limit: Math.min(Number(limit), 100),  // cap at 100 per page
    });

    res.json(result);
  } catch (err) {
    console.error('Dashboard /farmers error:', err.message);
    res.status(500).json({ error: 'Failed to fetch farmers' });
  }
});

// ── GET /dashboard/farmers/:phoneHash ────────────────────────────────────────
/**
 * Single farmer detail view — includes full assessment history.
 * Used when field officer clicks on a farmer row.
 *
 * Response: full Farmer document including assessmentHistory array.
 */
router.get('/farmers/:phoneHash', async (req, res) => {
  try {
    const farmer = await getFarmerDetail(req.params.phoneHash);
    if (!farmer) return res.status(404).json({ error: 'Farmer not found' });
    res.json(farmer);
  } catch (err) {
    console.error('Dashboard /farmers/:hash error:', err.message);
    res.status(500).json({ error: 'Failed to fetch farmer detail' });
  }
});

// ── GET /dashboard/locations ──────────────────────────────────────────────────
/**
 * Per-county breakdown — useful for field officers covering a region.
 *
 * Response:
 * [{ _id: 'kiambu', totalFarmers: 34, avgScore: 67, tier1Count: 8, ... }]
 */
router.get('/locations', async (req, res) => {
  try {
    const summary = await getLocationSummary();
    res.json(summary);
  } catch (err) {
    console.error('Dashboard /locations error:', err.message);
    res.status(500).json({ error: 'Failed to fetch location summary' });
  }
});

// ── GET /dashboard/export ─────────────────────────────────────────────────────
/**
 * Flat export for CSV download or loan committee spreadsheet.
 * Query params: location, tier, communityTies, cropType
 *
 * Response: array of flat objects, one per farmer.
 * Frontend can convert to CSV using any CSV library.
 */
router.get('/export', async (req, res) => {
  try {
    const { location, tier, communityTies, cropType } = req.query;
    const rows = await exportFarmers({ location, tier, communityTies, cropType });

    // Set CSV headers if client requests it
    if (req.headers.accept === 'text/csv') {
      if (rows.length === 0) return res.send('');
      const headers = Object.keys(rows[0]).join(',');
      const lines   = rows.map(r =>
        Object.values(r).map(v =>
          v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`
        ).join(',')
      );
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="shambai_farmers.csv"');
      return res.send([headers, ...lines].join('\n'));
    }

    res.json(rows);
  } catch (err) {
    console.error('Dashboard /export error:', err.message);
    res.status(500).json({ error: 'Failed to export farmers' });
  }
});

module.exports = router;