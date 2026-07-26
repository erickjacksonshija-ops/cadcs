const cookieSignature = require('cookie-signature');
const env = require('../config/env');
const sessionStore = require('../config/sessionStore');

// The "token" is exactly the same signed-session-id format express-session
// already puts in the 'connect.sid' cookie ('s:' + HMAC-signed sid), backed
// by the same MySQL session store -- not a separate JWT scheme. This exists
// because some hosting environments (verified: GitHub Codespaces' port
// forwarding relay, both public and private) strip Set-Cookie from the
// origin app entirely, so the browser never receives the session cookie no
// matter how correctly the server sets it. Cookie auth stays the primary,
// unchanged path (native hosting, a real VPS); this is a same-security-model
// fallback carried via an Authorization header instead of a cookie, for
// environments where cookies just don't arrive.
function signSessionId(sessionId) {
  return `s:${cookieSignature.sign(sessionId, env.sessionSecret)}`;
}

function verifyToken(token) {
  if (!token || !token.startsWith('s:')) return null;
  return cookieSignature.unsign(token.slice(2), env.sessionSecret) || null;
}

// Looks up the session the same way the socket-auth path already does.
// Returns { sessionId, user } or null.
function resolveToken(token) {
  const sessionId = verifyToken(token);
  if (!sessionId) return Promise.resolve(null);

  return new Promise((resolve) => {
    sessionStore.get(sessionId, (err, session) => {
      if (err || !session || !session.user) return resolve(null);
      resolve({ sessionId, user: session.user });
    });
  });
}

function destroyToken(token) {
  const sessionId = verifyToken(token);
  if (!sessionId) return Promise.resolve();
  return new Promise((resolve) => {
    sessionStore.destroy(sessionId, () => resolve());
  });
}

module.exports = { signSessionId, verifyToken, resolveToken, destroyToken };
