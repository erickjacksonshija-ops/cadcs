const express = require('express');
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

module.exports = router;
