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

  osrmBaseUrl: process.env.OSRM_BASE_URL || 'http://localhost:5000',
  nominatimBaseUrl: process.env.NOMINATIM_BASE_URL || 'http://localhost:8080',

  loginRateLimitMax: parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '10', 10),
  responseTimeBenchmarkSeconds: parseInt(process.env.RESPONSE_TIME_BENCHMARK_SECONDS || '480', 10),
  hospitalAckEscalationSeconds: parseInt(process.env.HOSPITAL_ACK_ESCALATION_SECONDS || '90', 10),
  ambulanceStaleSignalSeconds: parseInt(process.env.AMBULANCE_STALE_SIGNAL_SECONDS || '60', 10),
};
