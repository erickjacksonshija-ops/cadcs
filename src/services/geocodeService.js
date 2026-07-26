const env = require('../config/env');

const REQUEST_TIMEOUT_MS = 5000;

class NominatimUnavailableError extends Error {
  constructor(cause) {
    super('Nominatim geocoding service unavailable');
    this.name = 'NominatimUnavailableError';
    this.cause = cause;
  }
}

// Address/landmark search is a convenience layered on top of click-to-pin
// (see plan: "Incident Intake & Location Capture") -- click-to-pin always
// works with no external dependency, so a Nominatim outage or an empty
// result set is never a hard failure for the dispatcher, just an empty
// list the UI falls back from.
async function search(query, { limit = 5 } = {}) {
  const url = `${env.nominatimBaseUrl}/search?` + new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: String(limit),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      // Nominatim's usage policy requires a identifying User-Agent on every
      // request -- self-hosting doesn't remove that expectation, and a
      // default/missing one gets silently rate-limited by some setups.
      headers: { 'User-Agent': 'CADCS/1.0 (Centralized Ambulance Dispatch & Command System)' },
    });
    if (!res.ok) {
      throw new Error(`Nominatim responded with HTTP ${res.status}`);
    }
    const results = await res.json();
    return results.map((r) => ({
      displayName: r.display_name,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
    }));
  } catch (err) {
    throw new NominatimUnavailableError(err);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { search, NominatimUnavailableError };
