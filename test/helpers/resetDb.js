require('./loadTestEnv');
const pool = require('../../src/config/db');

const TABLES = [
  'sessions',
  'hospital_notifications',
  'ambulance_location_pings',
  'incident_events',
  'incidents',
  'ambulances',
  'users',
  'hospitals',
  'providers',
];

async function resetDb() {
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of TABLES) {
      await conn.query(`TRUNCATE TABLE ${table}`);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
}

module.exports = resetDb;
