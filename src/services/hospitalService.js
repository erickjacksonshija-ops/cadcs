const pool = require('../config/db');
const { POINT_SQL, latLngColumns } = require('./geo');

// Explicit ST_X/ST_Y in every SELECT (via latLngColumns) rather than
// relying on the driver to auto-parse the POINT column -- see geo.js for
// why the axis order matters here.
const SELECT_COLUMNS = `
  id, name, ${latLngColumns('location')},
  address, contact_phone, active, diversion_status, diversion_reason, diversion_set_at, created_at
`;

async function createHospital({ name, lat, lng, address, contactPhone }) {
  const [result] = await pool.query(
    `INSERT INTO hospitals (name, location, address, contact_phone)
     VALUES (:name, ${POINT_SQL}, :address, :contactPhone)`,
    { name, lat, lng, address: address || null, contactPhone: contactPhone || null }
  );
  return findById(result.insertId);
}

async function findById(id) {
  const [rows] = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM hospitals WHERE id = :id LIMIT 1`,
    { id }
  );
  return rows[0] || null;
}

async function list({ activeOnly = true } = {}) {
  const sql = `SELECT ${SELECT_COLUMNS} FROM hospitals ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY name`;
  const [rows] = await pool.query(sql);
  return rows;
}

// Straight-line pre-sort from a given origin -- mirrors dispatchService's
// preFilterCandidates (cheap DB-level Haversine first, OSRM refines after).
// Used to rank hospitals for the crew's destination picker instead of
// handing back an unordered list (see dispatchService.rankHospitals).
async function listWithDistanceFrom(lat, lng, { activeOnly = true } = {}) {
  const [rows] = await pool.query(
    `SELECT id, name, ${latLngColumns('location')}, address, contact_phone,
       diversion_status, diversion_reason,
       ST_Distance_Sphere(location, ST_SRID(POINT(:lat, :lng), 4326)) AS haversine_meters
     FROM hospitals
     ${activeOnly ? 'WHERE active = 1' : ''}
     ORDER BY haversine_meters ASC`,
    { lat, lng }
  );
  return rows;
}

// Hospital staff self-report their own facility's capacity -- advisory
// only (see migration 012's rationale). setByUserId isn't persisted on the
// hospitals row itself (no audit trail there), but callers that care about
// who changed it should log their own event.
async function setDiversionStatus(id, { status, reason }) {
  const existing = await findById(id);
  if (!existing) return null;
  await pool.query(
    `UPDATE hospitals SET diversion_status = :status, diversion_reason = :reason, diversion_set_at = NOW(3)
     WHERE id = :id`,
    { id, status, reason: reason || null }
  );
  return findById(id);
}

// Editable fields only -- excludes `active`, handled separately by
// setActive (a hospital going inactive means it drops out of the crew's
// destination picker and dispatch's hospital-selection candidates).
async function updateHospital(id, { name, lat, lng, address, contactPhone }) {
  const existing = await findById(id);
  if (!existing) return null;
  await pool.query(
    `UPDATE hospitals SET name = :name, location = ${POINT_SQL}, address = :address, contact_phone = :contactPhone
     WHERE id = :id`,
    {
      id,
      name: name ?? existing.name,
      lat: lat ?? existing.lat,
      lng: lng ?? existing.lng,
      address: address !== undefined ? address || null : existing.address,
      contactPhone: contactPhone !== undefined ? contactPhone || null : existing.contact_phone,
    }
  );
  return findById(id);
}

// Soft delete/restore -- hospitals are referenced by past incidents'
// assigned_hospital_id, so hard DELETE isn't viable; deactivating removes
// it from live selection without touching history.
async function setActive(id, active) {
  const existing = await findById(id);
  if (!existing) return null;
  await pool.query('UPDATE hospitals SET active = :active WHERE id = :id', { id, active: active ? 1 : 0 });
  return findById(id);
}

module.exports = {
  createHospital,
  findById,
  list,
  listWithDistanceFrom,
  updateHospital,
  setActive,
  setDiversionStatus,
};
