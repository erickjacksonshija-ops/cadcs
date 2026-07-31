const express = require('express');
const { body, validationResult } = require('express-validator');
const hospitalService = require('../services/hospitalService');
const requireRole = require('../middleware/requireRole');
const { ROLES } = require('../config/roles');

const router = express.Router();

// Read-only hospital directory -- crew needs this to pick a destination
// when starting transport (see dispatchService's transporting-status
// hospitalId requirement); dispatchers may want it for situational
// awareness too. Write operations stay under /api/admin/hospitals.
router.get('/', requireRole(ROLES.CREW, ROLES.DISPATCHER, ROLES.ADMIN), async (_req, res, next) => {
  try {
    res.json({ hospitals: await hospitalService.list() });
  } catch (err) {
    next(err);
  }
});

// Must be registered before other /:id-shaped routes would ever be added
// here -- hospital staff manage only their own facility's diversion status,
// scoped off req.session.user.hospitalId, never a client-supplied id.
router.get('/mine', requireRole(ROLES.HOSPITAL_STAFF), async (req, res, next) => {
  try {
    const hospital = await hospitalService.findById(req.session.user.hospitalId);
    if (!hospital) return res.status(404).json({ error: 'Hospital not found' });
    res.json({ hospital });
  } catch (err) {
    next(err);
  }
});

// Advisory diversion status (see plan: "Hospital diversion/capacity
// status") -- hospital staff self-report so dispatch/crew hospital-ranking
// (dispatchService.rankHospitals) can surface accepting facilities first
// instead of blindly recommending a hospital that's currently too full to
// safely receive new patients.
router.post(
  '/mine/diversion-status',
  requireRole(ROLES.HOSPITAL_STAFF),
  body('status').isIn(['accepting', 'diversion']),
  body('reason').optional().isString().isLength({ max: 200 }),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    try {
      const hospital = await hospitalService.setDiversionStatus(req.session.user.hospitalId, {
        status: req.body.status,
        reason: req.body.reason,
      });
      if (!hospital) return res.status(404).json({ error: 'Hospital not found' });
      res.json({ hospital });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
