const sessionTokenService = require('../services/sessionTokenService');

// Runs after express-session, before routes. If the cookie already
// resolved a session (the normal case), this is a no-op. Otherwise, falls
// back to an 'Authorization: Bearer <token>' header carrying the same
// signed-session-id format the cookie would have carried -- see
// sessionTokenService for why this fallback exists.
async function tokenFallbackAuth(req, _res, next) {
  if (req.session && req.session.user) return next();

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next();

  const resolved = await sessionTokenService.resolveToken(header.slice('Bearer '.length));
  if (resolved) {
    req.session.user = resolved.user;
    req.tokenSessionId = resolved.sessionId;
    // req.session here is a fresh, cookie-less session express-session
    // created for this request -- it is NOT the session the token points
    // to (that one already exists in the store at resolved.sessionId).
    // Setting .user on it would otherwise mark it dirty and cause
    // express-session to persist it as an orphan row when the response
    // ends.
    req.session.save = (cb) => cb && cb();
  }
  next();
}

module.exports = tokenFallbackAuth;
