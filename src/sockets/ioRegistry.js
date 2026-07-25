// Small registry so services (dispatchService, notificationService, etc,
// in later sprints) can broadcast without importing sockets/index.js
// directly and risking a circular require.
let io = null;

function setIo(instance) {
  io = instance;
}

function getIo() {
  if (!io) throw new Error('Socket.IO server not initialized yet');
  return io;
}

// Safe to call from anywhere that broadcasts opportunistically (e.g.
// dispatchService) without forcing every caller/test to spin up a real
// Socket.IO server first -- returns null instead of throwing if sockets
// haven't been attached (createApp()-only tests, for instance).
function tryGetIo() {
  return io;
}

module.exports = { setIo, getIo, tryGetIo };
