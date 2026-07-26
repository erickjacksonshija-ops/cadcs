const cookie = require('cookie');
const cookieSignature = require('cookie-signature');
const env = require('../config/env');
const sessionStore = require('../config/sessionStore');
const sessionTokenService = require('../services/sessionTokenService');

const SESSION_COOKIE_NAME = 'connect.sid';

// Sockets are never anonymous and never choose their own room -- this
// middleware is the only path to an authenticated socket.data.user, using
// the SAME session cookie (and the same MySQL-backed session store) as the
// REST API, so a socket can never see more than the browser's own logged-in
// session already permits. Falls back to the same Authorization-token
// scheme the REST API uses (see sessionTokenService) when no cookie header
// is present -- some hosting environments (verified: GitHub Codespaces'
// port-forwarding relay) never deliver the cookie at all.
function socketSessionAuth(socket, next) {
  const rawCookieHeader = socket.handshake.headers.cookie;
  if (rawCookieHeader) {
    const cookies = cookie.parse(rawCookieHeader);
    const raw = cookies[SESSION_COOKIE_NAME];
    if (raw && raw.startsWith('s:')) {
      const sid = cookieSignature.unsign(raw.slice(2), env.sessionSecret);
      if (sid) {
        return sessionStore.get(sid, (err, session) => {
          if (err || !session || !session.user) return next(new Error('unauthorized'));
          socket.data.user = session.user;
          socket.data.sessionId = sid;
          next();
        });
      }
    }
  }

  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('unauthorized'));

  sessionTokenService.resolveToken(token).then((resolved) => {
    if (!resolved) return next(new Error('unauthorized'));
    socket.data.user = resolved.user;
    socket.data.sessionId = resolved.sessionId;
    next();
  });
}

module.exports = socketSessionAuth;
