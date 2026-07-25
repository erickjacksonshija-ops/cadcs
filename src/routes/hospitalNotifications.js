const express = require('express');
const { param, validationResult } = require('express-validator');
const notificationService = require('../services/notificationService');
const requireRole = require('../middleware/requireRole');
const { ROLES } = require('../config/roles');

const router = express.Router();

// Scoped to req.session.user.hospitalId throughout -- a hospital_staff
// user can only ever see/acknowledge notifications for their own
// hospital, never chosen by the client.
router.get('/', requireRole(ROLES.HOSPITAL_STAFF), async (req, res, next) => {
  try {
    res.json({ notifications: await notificationService.listForHospital(req.session.user.hospitalId) });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/:id/acknowledge',
  requireRole(ROLES.HOSPITAL_STAFF),
  param('id').isInt(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid input', details: errors.array() });

    try {
      const notification = await notificationService.acknowledge(
        req.params.id,
        req.session.user.hospitalId,
        req.session.user.id
      );
      if (!notification) {
        return res.status(409).json({ error: 'Notification not found, not yours, or already acknowledged' });
      }
      res.json({ notification });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
