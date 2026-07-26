const pool = require('../config/db');
const { POINT_SQL, latLngColumns } = require('./geo');

const SELECT_COLUMNS = `
  a.id, a.provider_id, a.call_sign, a.capability_level, a.status,
  ${latLngColumns('a.current_location')},
  a.last_ping_at, a.current_crew_user_id, a.active, a.created_at
`;

// current_location/last_ping_at are intentionally not set here -- an
// ambulance has no position until its crew app sends the first GPS ping
// (see 004_create_ambulances.sql for why the column stays nullable rather
// than defaulting to a fake location).
async function createAmbulance({ providerId, callSign, capabilityLevel }) {
  const [result] = await pool.query(
    `INSERT INTO ambulances (provider_id, call_sign, capability_level, status)
     VALUES (:providerId, :callSign, :capabilityLevel, 'out_of_service')`,
    { providerId, callSign, capabilityLevel }
  );
  return findById(result.insertId);
}

async function findById(id) {
  const [rows] = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM ambulances a WHERE a.id = :id LIMIT 1`,
    { id }
  );
  return rows[0] || null;
}

async function list({ providerId, status } = {}) {
  const clauses = [];
  const params = {};
  if (providerId) {
    clauses.push('a.provider_id = :providerId');
    params.providerId = providerId;
  }
  if (status) {
    clauses.push('a.status = :status');
    params.status = status;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM ambulances a ${where} ORDER BY a.call_sign`,
    params
  );
  return rows;
}

// Called on every GPS ping from a crew's PWA -- always updates the live
// position, so the dispatcher map is current. Sampled history snapshots
// (ambulance_location_pings) are throttled separately by the caller (see
// sockets/index.js), not on every single ping, to keep that table's
// growth sane (see 007_create_ambulance_location_pings.sql).
async function updateLocation(ambulanceId, lat, lng) {
  await pool.query(
    `UPDATE ambulances SET current_location = ${POINT_SQL}, last_ping_at = NOW(3) WHERE id = :ambulanceId`,
    { ambulanceId, lat, lng }
  );
  return findById(ambulanceId);
}

async function recordLocationPing(ambulanceId, lat, lng) {
  await pool.query(
    `INSERT INTO ambulance_location_pings (ambulance_id, location) VALUES (:ambulanceId, ${POINT_SQL})`,
    { ambulanceId, lat, lng }
  );
}

// Identity/capability fields only -- deliberately does not touch `status`,
// which is dispatchService's domain (crew-initiated transitions, atomic
// compare-and-swap assignment) and must never be overwritten by an
// unrelated admin edit mid-mission.
async function updateAmbulance(id, { providerId, callSign, capabilityLevel }) {
  const existing = await findById(id);
  if (!existing) return null;
  await pool.query(
    `UPDATE ambulances SET provider_id = :providerId, call_sign = :callSign, capability_level = :capabilityLevel
     WHERE id = :id`,
    {
      id,
      providerId: providerId ?? existing.provider_id,
      callSign: callSign ?? existing.call_sign,
      capabilityLevel: capabilityLevel ?? existing.capability_level,
    }
  );
  return findById(id);
}

// Soft delete/restore (retiring a unit from the fleet) -- distinct from
// `status`, which tracks live operational state. An inactive ambulance is
// excluded from dispatch candidate lists regardless of what `status` says.
async function setActive(id, active) {
  const existing = await findById(id);
  if (!existing) return null;
  await pool.query('UPDATE ambulances SET active = :active WHERE id = :id', { id, active: active ? 1 : 0 });
  return findById(id);
}

module.exports = {
  createAmbulance,
  findById,
  list,
  updateLocation,
  recordLocationPing,
  updateAmbulance,
  setActive,
};
