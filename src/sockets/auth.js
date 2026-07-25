const cookie = require('cookie');
const cookieSignature = require('cookie-signature');
const env = require('../config/env');
const sessionStore = require('../config/sessionStore');

const SESSION_COOKIE_NAME = 'connect.sid';

// Sockets are never anonymous and never choose their own room -- this
// middleware is the only path to an authenticated socket.data.user, using
// the SAME session cookie (and the same MySQL-backed session store) as the
// REST API, so a socket can never see more than the browser's own logged-in
// session already permits.
function socketSessionAuth(socket, next) {
  const rawCookieHeader = socket.handshake.headers.cookie;
  if (!rawCookieHeader) return next(new Error('unauthorized'));

  const cookies = cookie.parse(rawCookieHeader);
  const raw = cookies[SESSION_COOKIE_NAME];
  if (!raw || !raw.startsWith('s:')) return next(new Error('unauthorized'));

  const sid = cookieSignature.unsign(raw.slice(2), env.sessionSecret);
  if (!sid) return next(new Error('unauthorized'));

  sessionStore.get(sid, (err, session) => {
    if (err || !session || !session.user) return next(new Error('unauthorized'));
    socket.data.user = session.user;
    socket.data.sessionId = sid;
    next();
  });
}

module.exports = socketSessionAuth;
