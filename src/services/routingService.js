const env = require('../config/env');

const REQUEST_TIMEOUT_MS = 5000;

class OsrmUnavailableError extends Error {
  constructor(cause) {
    super('OSRM routing service unavailable');
    this.name = 'OsrmUnavailableError';
    this.cause = cause;
  }
}

// OSRM's own coordinate format is strictly "{lng},{lat}" -- unrelated to,
// and not to be confused with, the separate MySQL SRID-4326 axis-order
// gotcha handled in geo.js. Kept as one explicit conversion point at the
// API boundary so the two concerns never get tangled together.
function toOsrmCoordString({ lat, lng }) {
  return `${lng},${lat}`;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`OSRM responded with HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    throw new OsrmUnavailableError(err);
  } finally {
    clearTimeout(timer);
  }
}

// Real road-network distance/duration from one origin (the incident) to
// many destinations (candidate ambulances), in a single OSRM /table call --
// see dispatchService for why this matters over straight-line distance.
// Returns [{ durationSeconds, distanceMeters }, ...] in the same order as
// `destinations`, or throws OsrmUnavailableError if OSRM can't be reached
// (the caller is expected to fall back to Haversine-only ranking).
async function getDurationsAndDistances(origin, destinations) {
  const coords = [origin, ...destinations].map(toOsrmCoordString).join(';');
  const destIndices = destinations.map((_, i) => i + 1).join(';');
  const url = `${env.osrmBaseUrl}/table/v1/driving/${coords}?sources=0&destinations=${destIndices}&annotations=duration,distance`;

  const data = await fetchWithTimeout(url);
  if (data.code !== 'Ok') {
    throw new OsrmUnavailableError(new Error(`OSRM table response code: ${data.code}`));
  }

  return destinations.map((_, i) => ({
    durationSeconds: data.durations[0][i],
    distanceMeters: data.distances[0][i],
  }));
}

// Full route geometry + ETA from one point to another, for the crew PWA's
// turn-by-turn view.
async function getRoute(origin, destination) {
  const coords = [origin, destination].map(toOsrmCoordString).join(';');
  const url = `${env.osrmBaseUrl}/route/v1/driving/${coords}?overview=full&geometries=geojson`;

  const data = await fetchWithTimeout(url);
  if (data.code !== 'Ok' || !data.routes?.length) {
    throw new OsrmUnavailableError(new Error(`OSRM route response code: ${data.code}`));
  }

  const route = data.routes[0];
  return {
    durationSeconds: route.duration,
    distanceMeters: route.distance,
    geometry: route.geometry, // GeoJSON LineString
  };
}

module.exports = { getDurationsAndDistances, getRoute, OsrmUnavailableError };
