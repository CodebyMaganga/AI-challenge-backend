/**
 * weatherService.js — climate risk scoring by location
 *
 * Two data sources:
 *
 * 1. NASA POWER API (free, no key needed)
 *    https://power.larc.nasa.gov/api/temporal/climatology/point
 *    Returns long-term rainfall averages by lat/lon.
 *    We use this to assess drought risk for the farmer's county.
 *
 * 2. Hardcoded county risk table (fallback + enrichment)
 *    Based on Kenya Meteorological Department drought frequency data.
 *    Used when NASA API is slow or unavailable.
 *
 * Output:
 *   climateRiskIndex  — 1 (low) to 10 (very high)
 *   droughtRisk       — 'low' | 'moderate' | 'high' | 'very_high'
 *   rainfallMmPerYear — estimated annual rainfall
 *   seasonMatch       — does the farmer's season match the county's best season?
 *   weatherScore      — penalty points subtracted from total (0 to -80)
 *   recommendation    — plain text advice about climate risk
 */

const https = require('https');

// ── Kenya county coordinates + baseline risk ──────────────────────────────────
// Risk index 1–10: based on KMD historical drought frequency
// Higher = more drought-prone = higher credit risk

const COUNTY_DATA = {
  kiambu:   { lat: -1.03,  lon: 36.82, baseRisk: 3, name: 'Kiambu'   },
  muranga:  { lat: -0.72,  lon: 37.15, baseRisk: 3, name: "Murang'a" },
  machakos: { lat: -1.52,  lon: 37.26, baseRisk: 6, name: 'Machakos' },
  nakuru:   { lat: -0.30,  lon: 36.07, baseRisk: 4, name: 'Nakuru'   },
  kisumu:   { lat: -0.10,  lon: 34.75, baseRisk: 3, name: 'Kisumu'   },
  siaya:    { lat:  0.06,  lon: 34.29, baseRisk: 4, name: 'Siaya'    },
  meru:     { lat:  0.05,  lon: 37.65, baseRisk: 4, name: 'Meru'     },
  kitui:    { lat: -1.37,  lon: 38.01, baseRisk: 8, name: 'Kitui'    },
  makueni:  { lat: -2.00,  lon: 37.62, baseRisk: 8, name: 'Makueni'  },
  mandera:  { lat:  3.94,  lon: 41.86, baseRisk:10, name: 'Mandera'  },
  turkana:  { lat:  3.12,  lon: 35.59, baseRisk:10, name: 'Turkana'  },
  other:    { lat: -1.28,  lon: 36.82, baseRisk: 5, name: 'Kenya'    },
};

// Season risk multiplier — some counties are riskier in specific seasons
const SEASON_RISK = {
  long_rains:  0.8,  // March–May generally more reliable
  short_rains: 1.2,  // Oct–Dec more variable
  year_round:  1.0,
};

// ── NASA POWER API call ───────────────────────────────────────────────────────

function fetchNASARainfall(lat, lon) {
  return new Promise((resolve) => {
    const url =
      `https://power.larc.nasa.gov/api/temporal/climatology/point` +
      `?parameters=PRECTOTCORR&community=AG&longitude=${lon}&latitude=${lat}&format=JSON`;

    const req = https.get(url, { timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json    = JSON.parse(data);
          const monthly = json?.properties?.parameter?.PRECTOTCORR;
          if (!monthly) return resolve(null);
          // Sum all months for annual total (mm/day × ~30 = mm/month)
          const annualMm = Object.values(monthly)
            .filter((_, i) => i < 12)             // exclude ANN key
            .reduce((sum, v) => sum + (v * 30), 0);
          resolve(Math.round(annualMm));
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ── Main function ─────────────────────────────────────────────────────────────

async function getWeatherRisk({ location, cropSeason, cropType }) {
  const county    = COUNTY_DATA[location] || COUNTY_DATA.other;
  const seasonMul = SEASON_RISK[cropSeason] || 1.0;

  // Try NASA API — 4s timeout, fallback to county table if slow
  let rainfallMm  = null;
  let dataSource  = 'county_table';

  try {
    rainfallMm = await fetchNASARainfall(county.lat, county.lon);
    if (rainfallMm) dataSource = 'nasa_power';
  } catch (_) {}

  // Derive risk index from NASA data if available, else use county baseline
  let climateRiskIndex = county.baseRisk;
  if (rainfallMm !== null) {
    // Low rainfall = higher risk
    if      (rainfallMm > 1200) climateRiskIndex = Math.max(1, county.baseRisk - 2);
    else if (rainfallMm > 800)  climateRiskIndex = county.baseRisk;
    else if (rainfallMm > 500)  climateRiskIndex = Math.min(10, county.baseRisk + 1);
    else                        climateRiskIndex = Math.min(10, county.baseRisk + 3);
  }

  // Apply season multiplier
  climateRiskIndex = Math.min(10, Math.round(climateRiskIndex * seasonMul));

  // Crop-specific adjustment
  // Dairy is less rainfall-dependent; horticulture is very sensitive
  if (cropType === 'dairy')        climateRiskIndex = Math.max(1, climateRiskIndex - 1);
  if (cropType === 'horticulture') climateRiskIndex = Math.min(10, climateRiskIndex + 1);

  // Drought risk label
  let droughtRisk;
  if      (climateRiskIndex <= 3)  droughtRisk = 'low';
  else if (climateRiskIndex <= 5)  droughtRisk = 'moderate';
  else if (climateRiskIndex <= 7)  droughtRisk = 'high';
  else                             droughtRisk = 'very_high';

  // Weather score — penalty only (0 to -80)
  // Low risk = 0 penalty, very high risk = -80
  const weatherScore = -Math.round(((climateRiskIndex - 1) / 9) * 80);

  // Plain-language recommendation for explainer
  const recommendation = buildRecommendation(droughtRisk, county.name, cropType);

  return {
    county:           county.name,
    location,
    climateRiskIndex,
    droughtRisk,
    rainfallMm:       rainfallMm || null,
    seasonMatch:      cropSeason !== 'short_rains' || climateRiskIndex <= 5,
    weatherScore,
    dataSource,
    recommendation,
  };
}

// ── Recommendation text ───────────────────────────────────────────────────────

function buildRecommendation(risk, county, crop) {
  const recs = {
    low:       `${county} ina mvua nzuri. Shamba lako liko salama kwa msimu huu.`,
    moderate:  `${county} ina hatari ya wastani ya ukame. Fikiria bima ya mazao kupunguza hatari.`,
    high:      `${county} ina hatari kubwa ya ukame. Bima ya mazao inashauriwa sana.`,
    very_high: `${county} ina hatari kubwa sana ya ukame. Tafadhali fikiria kilimo cha umwagiliaji au bima ya mazao.`,
  };
  return recs[risk] || recs.moderate;
}

module.exports = { getWeatherRisk };