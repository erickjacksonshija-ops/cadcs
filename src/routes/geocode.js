const express = require('express');
const { query, validationResult } = require('express-validator');
const geocodeService = require('../services/geocodeService');
const requireRole = require('../middleware/requireRole');
const { ROLES } = require('../config/roles');

const router = express.Router();

// Address/landmark search backing the dispatcher's incident-creation map --
// same roles as incident creation itself (see routes/incidents.js). A
// Nominatim outage returns an empty result list rather than a 5xx, so the
// dispatcher UI degrades to click-to-pin without an error interrupting
// the call intake flow.
router.get(
  '/search',
  requireRole(ROLES.DISPATCHER, ROLES.ADMIN),
  query('q').isString().trim().isLength({ min: 2 }),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    }
    try {
      const results = await geocodeService.search(req.query.q);
      res.json({ results });
    } catch (err) {
      if (err instanceof geocodeService.NominatimUnavailableError) {
        return res.json({ results: [], unavailable: true });
      }
      next(err);
    }
  }
);

module.exports = router;
