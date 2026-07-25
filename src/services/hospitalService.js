const pool = require('../config/db');
const { POINT_SQL, latLngColumns } = require('./geo');

// Explicit ST_X/ST_Y in every SELECT (via latLngColumns) rather than
// relying on the driver to auto-parse the POINT column -- see geo.js for
// why the axis order matters here.
const SELECT_COLUMNS = `
  id, name, ${latLngColumns('location')},
  address, contact_phone, active, created_at
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

module.exports = { createHospital, findById, list };
