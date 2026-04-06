// ble-service/hr-utils.js
// Shared HR zone calculation — used by both HRZoneController and CoachingEngine

const ZONE_BOUNDARIES = [
  { zone: 1, low: 0,  high: 60 },
  { zone: 2, low: 60, high: 70 },
  { zone: 3, low: 70, high: 80 },
  { zone: 4, low: 80, high: 90 },
  { zone: 5, low: 90, high: 100 },
];

function getZone(hr, maxHR) {
  if (!hr || hr <= 0 || !maxHR) return null;
  const pct = (hr / maxHR) * 100;
  if (pct < 60) return 1;
  if (pct < 70) return 2;
  if (pct < 80) return 3;
  if (pct < 90) return 4;
  return 5;
}

function getZoneBoundaries(zone) {
  return ZONE_BOUNDARIES.find(z => z.zone === zone) || null;
}

function getHRPercent(hr, maxHR) {
  if (!hr || !maxHR) return 0;
  return (hr / maxHR) * 100;
}

module.exports = { getZone, getZoneBoundaries, getHRPercent, ZONE_BOUNDARIES };
