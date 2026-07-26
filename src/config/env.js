require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  sessionSecret: required('SESSION_SECRET'),

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: required('DB_NAME'),
  },

  // Restricted DB user for incident_events writes (INSERT, SELECT only --
  // see docs/audit-log-integrity.md and scripts/harden-audit-log-grants.sh).
  // Falls back to the main app DB user when unset, so environments that
  // haven't run the hardening script yet keep working exactly as before,
  // just without the DB-level enforcement.
  dbAuditWriter: {
    user: process.env.DB_AUDIT_USER || process.env.DB_USER,
    password: process.env.DB_AUDIT_PASSWORD || process.env.DB_PASSWORD,
  },

  osrmBaseUrl: process.env.OSRM_BASE_URL || 'http://localhost:5000',
  nominatimBaseUrl: process.env.NOMINATIM_BASE_URL || 'http://localhost:8080',

  // Web Push (VAPID) -- see docs on pushService.js. Left undefined (not
  // `required()`) when unset, rather than throwing at startup: an
  // environment that hasn't generated keys yet should still be able to run
  // the rest of the app, just without push notifications.
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || null,
    privateKey: process.env.VAPID_PRIVATE_KEY || null,
    contactEmail: process.env.VAPID_CONTACT_EMAIL || 'mailto:admin@example.com',
  },

  loginRateLimitMax: parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '10', 10),
  responseTimeBenchmarkSeconds: parseInt(process.env.RESPONSE_TIME_BENCHMARK_SECONDS || '480', 10),
  hospitalAckEscalationSeconds: parseInt(process.env.HOSPITAL_ACK_ESCALATION_SECONDS || '90', 10),
  ambulanceStaleSignalSeconds: parseInt(process.env.AMBULANCE_STALE_SIGNAL_SECONDS || '60', 10),
};
