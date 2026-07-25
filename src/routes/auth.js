const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const userService = require('../services/userService');
const requireAuth = require('../middleware/requireAuth');
const env = require('../config/env');

const router = express.Router();

// Brute-force protection on login: 10 attempts per 15 minutes per IP in
// production. Configurable via env because this middleware's in-memory
// counter is shared for the lifetime of the app instance -- in a test
// file that logs in many times across unrelated test cases, the
// production threshold trips on legitimate, unrelated test traffic (see
// .env.test's much higher LOGIN_RATE_LIMIT_MAX). This is exactly the
// behavior the limiter is supposed to have; only the threshold changes.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.loginRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
});

router.post(
  '/login',
  loginLimiter,
  body('email').isEmail().normalizeEmail(),
  body('password').isString().notEmpty(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Invalid input', details: errors.array() });
      }

      const { email, password } = req.body;
      const user = await userService.verifyCredentials(email, password);
      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      // Store only what's needed for authorization decisions -- never the
      // password hash -- in the session.
      req.session.user = {
        id: user.id,
        name: user.name,
        role: user.role,
        providerId: user.provider_id,
        hospitalId: user.hospital_id,
      };

      res.json({ user: req.session.user });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/logout', requireAuth, (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('connect.sid');
    res.status(204).end();
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

module.exports = router;
