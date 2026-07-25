const MySQLStore = require('express-mysql-session')(require('express-session'));
const env = require('./env');

// Dedicated pool for sessions so session I/O never contends with the app's
// request-handling connection pool.
const sessionStore = new MySQLStore({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  connectionLimit: 10,
  createDatabaseTable: true,
  schema: {
    tableName: 'sessions',
    columnNames: {
      session_id: 'session_id',
      expires: 'expires',
      data: 'data',
    },
  },
});

module.exports = sessionStore;
