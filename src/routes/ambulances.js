const express = require('express');
const ambulanceService = require('../services/ambulanceService');
const requireRole = require('../middleware/requireRole');
const { ROLES } = require('../config/roles');

const router = express.Router();

// Read-only fleet visibility for dispatchers (the live map needs to show
// current ambulance positions on page load, not just wait for the next
// Socket.IO GPS event) -- write operations (create/manage ambulances)
// stay under /api/admin/ambulances, admin-only.
router.get('/', requireRole(ROLES.DISPATCHER, ROLES.ADMIN), async (req, res, next) => {
  try {
    res.json({ ambulances: await ambulanceService.list() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
