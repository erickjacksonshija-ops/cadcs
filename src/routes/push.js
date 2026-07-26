const express = require('express');
const { body, validationResult } = require('express-validator');
const env = require('../config/env');
const pushService = require('../services/pushService');
const requireRole = require('../middleware/requireRole');
const { ROLES } = require('../config/roles');

const router = express.Router();

// Any authenticated role that receives push-worthy alerts: hospital staff
// (pre-notifications) and dispatchers/admins (escalation alerts). Crew is
// deliberately excluded -- their mission updates already arrive via the
// always-open, always-focused crew PWA's Socket.IO connection, which is a
// stronger guarantee than a backgrounded-tab push.
const PUSH_ROLES = [ROLES.HOSPITAL_STAFF, ROLES.DISPATCHER, ROLES.ADMIN];

router.get('/vapid-public-key', requireRole(...PUSH_ROLES), (_req, res) => {
  res.json({ publicKey: env.vapid.publicKey, configured: pushService.isConfigured });
});

router.post(
  '/subscribe',
  requireRole(...PUSH_ROLES),
  body('endpoint').isString().notEmpty(),
  body('keys.p256dh').isString().notEmpty(),
  body('keys.auth').isString().notEmpty(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    }
    try {
      await pushService.subscribe(req.session.user.id, req.body);
      res.status(201).json({ subscribed: true });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/unsubscribe',
  requireRole(...PUSH_ROLES),
  body('endpoint').isString().notEmpty(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    }
    try {
      await pushService.unsubscribe(req.session.user.id, req.body.endpoint);
      res.json({ subscribed: false });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
