const http = require('http');
const { Server } = require('socket.io');
const createApp = require('./app');
const attachSocketHandlers = require('./sockets');

// Builds the app/server/io triple without listening or touching
// process-wide signal handlers, so tests can start a real HTTP+Socket.IO
// server in-process (and close it cleanly) without side effects on other
// test files or the process itself. server.js wraps this for the actual
// running process.
function createServer() {
  const app = createApp();
  const server = http.createServer(app);
  const io = new Server(server);
  attachSocketHandlers(io);
  return { app, server, io };
}

module.exports = createServer;
