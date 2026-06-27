// routes/dashboard.js
/**
 * Dashboard API — field officer endpoints.
 * Already mounted at /dashboard in server.js.
 *
 * Endpoints (original — DO NOT TOUCH):
 *   GET  /dashboard/stats
 *   GET  /dashboard/farmers
 *   GET  /dashboard/farmers/:phoneHash
 *   GET  /dashboard/locations
 *   GET  /dashboard/export
 *
 * Endpoints (new — added below export):
 *   GET  /dashboard/chamas
 *   GET  /dashboard/farmers/:phoneHash/evidence
 *   POST /dashboard/farmers/:phoneHash/evidence
 *   POST /dashboard/upload
 */

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');

const {
  getDashboardStats,
  listFarmers,
  getFarmerDetail,
  getLocationSummary,
  exportFarmers,
} = require('../db/farmerStore');

const chamas = require('../db/chamaRegistry');
const Farmer = require('../db/farmerModel');

// ── Upload middleware setup (multer) ──────────────────────────────────────────
let upload;
try {
  const multer  = require('multer');
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = path.join(__dirname, '..', 'uploads');
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const hash = req.params.phoneHash || 'unknown';
      const ext  = path.extname(file.originalname);
      cb(null, `${hash.slice(0, 12)}_${Date.now()}${ext}`);
    },
  });

  const fileFilter = (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
    const ext     = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('Only PDF, JPG, and PNG files are accepted'));
  };

  upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });
} catch (e) {
  console.warn('multer not installed — file upload endpoints will return 501');
  upload = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORIGINAL ROUTES — DO NOT MODIFY
// ═══════════════════════════════════════════════════════════════════════════════

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
      limit: Math.min(Number(limit), 100),
    });

    res.json(result);
  } catch (err) {
    console.error('Dashboard /farmers error:', err.message);
    res.status(500).json({ error: 'Failed to fetch farmers' });
  }
});

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

router.get('/locations', async (req, res) => {
  try {
    const summary = await getLocationSummary();
    res.json(summary);
  } catch (err) {
    console.error('Dashboard /locations error:', err.message);
    res.status(500).json({ error: 'Failed to fetch location summary' });
  }
});

router.get('/export', async (req, res) => {
  try {
    const { location, tier, communityTies, cropType } = req.query;
    const rows = await exportFarmers({ location, tier, communityTies, cropType });

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

// ═══════════════════════════════════════════════════════════════════════════════
// NEW ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /dashboard/chamas
router.get('/chamas', (req, res) => {
  const { county, subCounty } = req.query;
  let data = chamas;
  if (county)    data = data.filter(c => c.county    === county);
  if (subCounty) data = data.filter(c => c.subCounty === subCounty);
  res.json(data);
});

// GET /dashboard/farmers/:phoneHash/evidence
router.get('/farmers/:phoneHash/evidence', async (req, res) => {
  try {
    const farmer = await Farmer.findOne(
      { phoneHash: req.params.phoneHash },
      { evidenceVerification: 1 }
    ).lean();

    const evidence = farmer?.evidenceVerification || {
      mpesaStatement: { uploaded: false, filename: null },
      chama:          { id: null, name: null, verified: false },
      land:           { type: null, uploaded: false, filename: null },
      communityVerification: {
        chamaMembershipVerified:    false,
        cooperativeMemberVerified:  false,
        womensGroupLeaderConfirmed: false,
      },
      notes:      '',
      verifiedBy: null,
      verifiedAt: null,
    };

    res.json(evidence);
  } catch (err) {
    console.error('GET /evidence error:', err.message);
    res.status(500).json({ error: 'Failed to fetch evidence record' });
  }
});

// POST /dashboard/farmers/:phoneHash/evidence
router.post('/farmers/:phoneHash/evidence', async (req, res) => {
  try {
    const { phoneHash } = req.params;
    const {
      mpesaStatement,
      chama: chamaId,
      landType,
      landDocument,
      chamaMembershipVerified,
      cooperativeMemberVerified,
      womensGroupLeaderConfirmed,
      notes,
      verifiedBy,
    } = req.body;

    const chamaRecord = chamas.find(c => c.id === chamaId) || null;

    const evidenceVerification = {
      mpesaStatement: {
        uploaded: !!mpesaStatement,
        filename: mpesaStatement || null,
      },
      chama: {
        id:       chamaId || null,
        name:     chamaRecord?.name || null,
        verified: !!chamaId,
      },
      land: {
        type:     landType     || null,
        uploaded: !!landDocument,
        filename: landDocument || null,
      },
      communityVerification: {
        chamaMembershipVerified:    chamaMembershipVerified    === true || chamaMembershipVerified    === 'true',
        cooperativeMemberVerified:  cooperativeMemberVerified  === true || cooperativeMemberVerified  === 'true',
        womensGroupLeaderConfirmed: womensGroupLeaderConfirmed === true || womensGroupLeaderConfirmed === 'true',
      },
      notes:      notes      || '',
      verifiedBy: verifiedBy || null,
      verifiedAt: new Date(),
    };

    const updated = await Farmer.findOneAndUpdate(
      { phoneHash },
      { $set: { evidenceVerification } },
      { new: true, upsert: false }
    );

    if (!updated) {
      return res.status(404).json({ error: 'Farmer not found — complete USSD assessment first' });
    }

    res.json({ success: true, message: 'Evidence saved', evidenceVerification });
  } catch (err) {
    console.error('POST /evidence error:', err.message);
    res.status(500).json({ error: 'Failed to save evidence' });
  }
});

// POST /dashboard/farmers/:phoneHash/simulate-mpesa
router.post('/farmers/:phoneHash/simulate-mpesa', async (req, res) => {
  try {
    const farmer = await getFarmerDetail(req.params.phoneHash);
    if (!farmer) return res.status(404).json({ error: 'Farmer not found' });

    // Simulate parsing an M‑Pesa statement
    const weeklyAmount = Math.floor(Math.random() * 800) + 200;
    const monthlyAmount = Math.floor(Math.random() * 600) + 100;
    const mpesaScore = Math.floor(Math.random() * 56) + 40; // 40–95

    const latestAssessment = farmer.assessmentHistory?.[0];
    if (!latestAssessment) return res.status(400).json({ error: 'No assessment to update' });

    latestAssessment.evidence = {
      ...latestAssessment.evidence,
      mpesaScore,
      mpesaWeekly: weeklyAmount,
      mpesaMonthly: monthlyAmount,
      mpesaStatementParsed: true,
    };

    // Mark as uploaded (pretend)
    if (!farmer.evidenceVerification) farmer.evidenceVerification = {};
    farmer.evidenceVerification.mpesaStatement = {
      uploaded: true,
      filename: 'statement-simulated.pdf', // dummy name
    };

    await farmer.save();
    const updatedFarmer = await rescoreFarmer(farmer);

    res.json({ success: true, farmer: updatedFarmer });
  } catch (err) {
    console.error('Simulate M-Pesa error:', err);
    res.status(500).json({ error: err.message || 'Simulation failed' });
  }
});

// POST /dashboard/upload
router.post('/upload', (req, res) => {
  if (!upload) {
    return res.status(501).json({
      error: 'File upload not available — run: npm install multer',
    });
  }

  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });

    res.json({
      success:  true,
      filename: req.file.filename,
      url:      `/uploads/${req.file.filename}`,
    });
  });
});

module.exports = router;