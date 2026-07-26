const mysql = require('mysql2/promise');
const env = require('./env');
const mainPool = require('./db');

// A genuinely separate pool -- authenticated as a DB user with only
// INSERT, SELECT granted on incident_events (see
// docs/audit-log-integrity.md and scripts/harden-audit-log-grants.sh) --
// is what makes that restriction actually bite. But only worth the extra
// connections when DB_AUDIT_USER is actually configured to something
// different; every environment that hasn't run the hardening script yet
// (all local dev, all of CI) would otherwise open a second full
// connection pool per process for no behavioral difference, since it'd
// authenticate as the exact same user as mainPool. With 16 Jest suites
// each requiring this module, that doubling was enough to push past
// MySQL's max_connections and produce cross-test flakiness that had
// nothing to do with audit logging -- reusing mainPool in the fallback
// case avoids that entirely.
const isConfigured = Boolean(process.env.DB_AUDIT_USER) && env.dbAuditWriter.user !== env.db.user;

const pool = isConfigured
  ? mysql.createPool({
      host: env.db.host,
      port: env.db.port,
      user: env.dbAuditWriter.user,
      password: env.dbAuditWriter.password,
      database: env.db.database,
      waitForConnections: true,
      connectionLimit: 5,
      namedPlaceholders: true,
      dateStrings: false,
    })
  : mainPool;

module.exports = pool;
