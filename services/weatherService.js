/**
 * weatherService.js — climate risk scoring by location
 *
 * FIXES from v1:
 *   1. getWeatherRisk now accepts (location, cropSeason, cropType) as
 *      separate args AND as a single object — both calling styles work.
 *   2. weatherScore is now 0–100 (positive, additive) not 0 to -80 (penalty).
 *      Low risk county = high score. High risk county = low score.
 *      scoreHelpers.js does: Math.round((weather.score / 100) * 20)
 *      So score range is now 0–20 pts contribution, never negative.
 */

const https = require('https');

const COUNTY_DATA = {
  kiambu:   { lat: -1.03,  lon: 36.82, baseRisk: 3, name: 'Kiambu'   },
  muranga:  { lat: -0.72,  lon: 37.15, baseRisk: 3, name: "Murang'a" },
  machakos: { lat: -1.52,  lon: 37.26, baseRisk: 6, name: 'Machakos' },
  nakuru:   { lat: -0.30,  lon: 36.07, baseRisk: 4, name: 'Nakuru'   },
  kisumu:   { lat: -0.10,  lon: 34.75, baseRisk: 3, name: 'Kisumu'   },
  nyeri:    { lat: -0.42,  lon: 36.95, baseRisk: 3, name: 'Nyeri'    },
  siaya:    { lat:  0.06,  lon: 34.29, baseRisk: 4, name: 'Siaya'    },
  meru:     { lat:  0.05,  lon: 37.65, baseRisk: 4, name: 'Meru'     },
  kitui:    { lat: -1.37,  lon: 38.01, baseRisk: 8, name: 'Kitui'    },
  makueni:  { lat: -2.00,  lon: 37.62, baseRisk: 8, name: 'Makueni'  },
  mandera:  { lat:  3.94,  lon: 41.86, baseRisk:10, name: 'Mandera'  },
  turkana:  { lat:  3.12,  lon: 35.59, baseRisk:10, name: 'Turkana'  },
  other:    { lat: -1.28,  lon: 36.82, baseRisk: 5, name: 'Kenya'    },
};

const SEASON_RISK = {
  long_rains:  0.8,   // March–May — more reliable
  short_rains: 1.2,   // Oct–Dec — more variable
  year_round:  1.0,
};

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
          const annualMm = Object.values(monthly)
            .filter((_, i) => i < 12)
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

/**
 * getWeatherRisk — accepts TWO calling styles:
 *
 *   Style A (old riskEngine): getWeatherRisk(location, cropSeason, cropType)
 *   Style B (object):         getWeatherRisk({ location, cropSeason, cropType })
 *
 * Both work. riskEngine.js calls Style A.
 */
async function getWeatherRisk(locationOrObj, cropSeasonArg, cropTypeArg) {
  // Normalise both calling styles
  let location, cropSeason, cropType;

  if (locationOrObj && typeof locationOrObj === 'object') {
    // Style B — object
    ({ location, cropSeason, cropType } = locationOrObj);
  } else {
    // Style A — separate args
    location   = locationOrObj;
    cropSeason = cropSeasonArg;
    cropType   = cropTypeArg;
  }

  console.log('🌦️  weatherService called with:', { location, cropSeason, cropType });

  const county    = COUNTY_DATA[location?.toLowerCase()] || COUNTY_DATA.other;
  const seasonMul = SEASON_RISK[cropSeason] || 1.0;

  console.log('🌦️  resolved county:', county.name, '| baseRisk:', county.baseRisk);

  // Try NASA API
  let rainfallMm = null;
  let dataSource = 'county_table';

  try {
    rainfallMm = await fetchNASARainfall(county.lat, county.lon);
    if (rainfallMm) dataSource = 'nasa_power';
    console.log('🌦️  NASA rainfall (mm/year):', rainfallMm, '| source:', dataSource);
  } catch (_) {
    console.log('🌦️  NASA API failed — using county table');
  }

  // Derive risk index
  let climateRiskIndex = county.baseRisk;
  if (rainfallMm !== null) {
    if      (rainfallMm > 1200) climateRiskIndex = Math.max(1, county.baseRisk - 2);
    else if (rainfallMm > 800)  climateRiskIndex = county.baseRisk;
    else if (rainfallMm > 500)  climateRiskIndex = Math.min(10, county.baseRisk + 1);
    else                        climateRiskIndex = Math.min(10, county.baseRisk + 3);
  }

  // Season multiplier
  climateRiskIndex = Math.min(10, Math.round(climateRiskIndex * seasonMul));

  // Crop adjustment
  if (cropType === 'dairy')        climateRiskIndex = Math.max(1, climateRiskIndex - 1);
  if (cropType === 'horticulture') climateRiskIndex = Math.min(10, climateRiskIndex + 1);

  // Drought risk label
  let droughtRisk;
  if      (climateRiskIndex <= 3) droughtRisk = 'low';
  else if (climateRiskIndex <= 5) droughtRisk = 'moderate';
  else if (climateRiskIndex <= 7) droughtRisk = 'high';
  else                            droughtRisk = 'very_high';

  // ── FIX: weatherScore is now 0–100 POSITIVE (not penalty) ─────────────────
  // climateRiskIndex 1 (safest) → score 100
  // climateRiskIndex 10 (riskiest) → score 0
  // scoreHelpers does: Math.round((weather.score / 100) * 20) → 0–20 pts added
  const score = Math.round(((10 - climateRiskIndex) / 9) * 100);

  console.log('🌦️  climateRiskIndex:', climateRiskIndex, '| weatherScore (0-100):', score);

  const recommendation = buildRecommendation(droughtRisk, county.name, cropType);

  return {
    county:           county.name,
    location:         location || 'unknown',
    climateRiskIndex,
    droughtRisk,
    rainfallMm:       rainfallMm || null,
    seasonMatch:      cropSeason !== 'short_rains' || climateRiskIndex <= 5,
    score,                    // ← renamed from weatherScore, now 0–100 positive
    weatherScore: score,      // ← keep old key too so nothing else breaks
    dataSource,
    recommendation,
  };
}

function buildRecommendation(risk, county, crop) {
  const recs = {
    low:       `${county} ina mvua nzuri. Shamba lako liko salama kwa msimu huu.`,
    moderate:  `${county} ina hatari ya wastani ya ukame. Fikiria bima ya mazao kupunguza hatari.`,
    high:      `${county} ina hatari kubwa ya ukame. Bima ya mazao inashauriwa sana.`,
    very_high: `${county} ina hatari kubwa sana ya ukame. Fikiria kilimo cha umwagiliaji au bima ya mazao.`,
  };
  return recs[risk] || recs.moderate;
}

module.exports = { getWeatherRisk };