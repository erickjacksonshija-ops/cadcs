const env = require('./config/env');
const pool = require('./config/db');
const sessionStore = require('./config/sessionStore');
const createServer = require('./createServer');

const { server } = createServer();

server.listen(env.port, () => {
  console.log(`CADCS server listening on port ${env.port} [${env.nodeEnv}]`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully...`);
  server.close(() => {
    sessionStore.close(() => {
      pool.end().then(() => process.exit(0));
    });
  });
  // Force-exit if something hangs -- e.g. an in-flight request never
  // completes -- so a stuck shutdown never blocks a container/orchestrator.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = server;
