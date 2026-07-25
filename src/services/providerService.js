const pool = require('../config/db');

async function createProvider({ name, type, contactPhone }) {
  const [result] = await pool.query(
    `INSERT INTO providers (name, type, contact_phone) VALUES (:name, :type, :contactPhone)`,
    { name, type, contactPhone: contactPhone || null }
  );
  return findById(result.insertId);
}

async function findById(id) {
  const [rows] = await pool.query('SELECT * FROM providers WHERE id = :id LIMIT 1', { id });
  return rows[0] || null;
}

async function list({ activeOnly = true } = {}) {
  const sql = activeOnly
    ? 'SELECT * FROM providers WHERE active = 1 ORDER BY name'
    : 'SELECT * FROM providers ORDER BY name';
  const [rows] = await pool.query(sql);
  return rows;
}

module.exports = { createProvider, findById, list };
