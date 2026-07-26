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

// Editable fields only -- deliberately excludes `active`, which has its
// own dedicated setActive (a distinct, more consequential action: an
// inactive provider's ambulances stop appearing as dispatch candidates).
async function updateProvider(id, { name, type, contactPhone }) {
  const existing = await findById(id);
  if (!existing) return null;
  await pool.query(
    `UPDATE providers SET name = :name, type = :type, contact_phone = :contactPhone WHERE id = :id`,
    {
      id,
      name: name ?? existing.name,
      type: type ?? existing.type,
      contactPhone: contactPhone !== undefined ? contactPhone || null : existing.contact_phone,
    }
  );
  return findById(id);
}

// Soft delete/restore -- providers are referenced by ambulances (and
// transitively by incident history), so a hard DELETE would either fail
// on the FK or silently orphan past dispatch records. Deactivating is the
// real-world equivalent of "this provider no longer operates here."
async function setActive(id, active) {
  const existing = await findById(id);
  if (!existing) return null;
  await pool.query('UPDATE providers SET active = :active WHERE id = :id', { id, active: active ? 1 : 0 });
  return findById(id);
}

module.exports = { createProvider, findById, list, updateProvider, setActive };
