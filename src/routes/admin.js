const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/db');
const userService = require('../services/userService');
const providerService = require('../services/providerService');
const hospitalService = require('../services/hospitalService');
const ambulanceService = require('../services/ambulanceService');
const analyticsService = require('../services/analyticsService');
const requireRole = require('../middleware/requireRole');
const { ROLES, ALL_ROLES } = require('../config/roles');

const router = express.Router();

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'Invalid input', details: errors.array() });
    return false;
  }
  return true;
}

// Translates known DB-driver error codes into clean, client-safe 4xx
// responses instead of leaking table/constraint names (see userService for
// the same pattern -- kept local here since these three resources are
// simple enough not to warrant their own error-mapping module yet).
function mapDbError(err) {
  if (err.code === 'ER_DUP_ENTRY') {
    return { status: 409, message: 'A record with that unique value already exists' };
  }
  if (err.code === 'ER_NO_REFERENCED_ROW_2') {
    return { status: 400, message: 'Referenced record (e.g. providerId) does not exist' };
  }
  return null;
}

// No public self-registration anywhere in this system -- accounts are
// safety-critical, so only an admin provisions dispatcher/crew/hospital
// staff/admin accounts (see "Account Provisioning" in the plan).
router.post(
  '/users',
  requireRole(ROLES.ADMIN),
  body('name').isString().trim().notEmpty(),
  body('email').isEmail().normalizeEmail(),
  body('password').isString().isLength({ min: 8 }),
  body('role').isIn(ALL_ROLES),
  body('phone').optional().isString(),
  body('providerId').optional().isInt(),
  body('hospitalId').optional().isInt(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Invalid input', details: errors.array() });
      }

      const { name, email, phone, password, role, providerId, hospitalId } = req.body;
      const user = await userService.createUser({
        name,
        email,
        phone,
        password,
        role,
        providerId,
        hospitalId,
      });

      res.status(201).json({ user: userService.toPublicUser(user) });
    } catch (err) {
      if (err instanceof userService.ValidationError || err instanceof userService.ConflictError) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  }
);

router.get('/users', requireRole(ROLES.ADMIN), async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, email, phone, role, provider_id, hospital_id, active, created_at FROM users ORDER BY name'
    );
    res.json({ users: rows });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/users/:id',
  requireRole(ROLES.ADMIN),
  param('id').isInt(),
  body('name').optional().isString().trim().notEmpty(),
  body('phone').optional().isString(),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const user = await userService.updateUser(req.params.id, req.body);
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json({ user: userService.toPublicUser(user) });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/users/:id/active',
  requireRole(ROLES.ADMIN),
  param('id').isInt(),
  body('active').isBoolean(),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const user = await userService.setActive(req.params.id, req.body.active);
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json({ user: userService.toPublicUser(user) });
    } catch (err) {
      next(err);
    }
  }
);

// Admin-mediated password reset (see userService.setPassword for why this
// exists instead of a self-service "forgot password" email flow).
router.post(
  '/users/:id/reset-password',
  requireRole(ROLES.ADMIN),
  param('id').isInt(),
  body('newPassword').isString().isLength({ min: 8 }),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const user = await userService.setPassword(req.params.id, req.body.newPassword);
      res.json({ user: userService.toPublicUser(user) });
    } catch (err) {
      if (err instanceof userService.ValidationError) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  }
);

// --- Providers -------------------------------------------------------

router.post(
  '/providers',
  requireRole(ROLES.ADMIN),
  body('name').isString().trim().notEmpty(),
  body('type').isIn(['hospital_owned', 'private', 'ngo']),
  body('contactPhone').optional().isString(),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const provider = await providerService.createProvider(req.body);
      res.status(201).json({ provider });
    } catch (err) {
      const mapped = mapDbError(err);
      if (mapped) return res.status(mapped.status).json({ error: mapped.message });
      next(err);
    }
  }
);

router.get('/providers', requireRole(ROLES.ADMIN), async (_req, res, next) => {
  try {
    res.json({ providers: await providerService.list({ activeOnly: false }) });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/providers/:id',
  requireRole(ROLES.ADMIN),
  param('id').isInt(),
  body('name').optional().isString().trim().notEmpty(),
  body('type').optional().isIn(['hospital_owned', 'private', 'ngo']),
  body('contactPhone').optional().isString(),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const provider = await providerService.updateProvider(req.params.id, req.body);
      if (!provider) return res.status(404).json({ error: 'Provider not found' });
      res.json({ provider });
    } catch (err) {
      const mapped = mapDbError(err);
      if (mapped) return res.status(mapped.status).json({ error: mapped.message });
      next(err);
    }
  }
);

router.patch(
  '/providers/:id/active',
  requireRole(ROLES.ADMIN),
  param('id').isInt(),
  body('active').isBoolean(),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const provider = await providerService.setActive(req.params.id, req.body.active);
      if (!provider) return res.status(404).json({ error: 'Provider not found' });
      res.json({ provider });
    } catch (err) {
      next(err);
    }
  }
);

// --- Hospitals ---------------------------------------------------------

router.post(
  '/hospitals',
  requireRole(ROLES.ADMIN),
  body('name').isString().trim().notEmpty(),
  body('lat').isFloat({ min: -90, max: 90 }),
  body('lng').isFloat({ min: -180, max: 180 }),
  body('address').optional().isString(),
  body('contactPhone').optional().isString(),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const hospital = await hospitalService.createHospital(req.body);
      res.status(201).json({ hospital });
    } catch (err) {
      const mapped = mapDbError(err);
      if (mapped) return res.status(mapped.status).json({ error: mapped.message });
      next(err);
    }
  }
);

router.get('/hospitals', requireRole(ROLES.ADMIN), async (_req, res, next) => {
  try {
    res.json({ hospitals: await hospitalService.list({ activeOnly: false }) });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/hospitals/:id',
  requireRole(ROLES.ADMIN),
  param('id').isInt(),
  body('name').optional().isString().trim().notEmpty(),
  body('lat').optional().isFloat({ min: -90, max: 90 }),
  body('lng').optional().isFloat({ min: -180, max: 180 }),
  body('address').optional().isString(),
  body('contactPhone').optional().isString(),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const hospital = await hospitalService.updateHospital(req.params.id, req.body);
      if (!hospital) return res.status(404).json({ error: 'Hospital not found' });
      res.json({ hospital });
    } catch (err) {
      const mapped = mapDbError(err);
      if (mapped) return res.status(mapped.status).json({ error: mapped.message });
      next(err);
    }
  }
);

router.patch(
  '/hospitals/:id/active',
  requireRole(ROLES.ADMIN),
  param('id').isInt(),
  body('active').isBoolean(),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const hospital = await hospitalService.setActive(req.params.id, req.body.active);
      if (!hospital) return res.status(404).json({ error: 'Hospital not found' });
      res.json({ hospital });
    } catch (err) {
      next(err);
    }
  }
);

// --- Ambulances ----------------------------------------------------------

router.post(
  '/ambulances',
  requireRole(ROLES.ADMIN),
  body('providerId').isInt(),
  body('callSign').isString().trim().notEmpty(),
  body('capabilityLevel').isIn(['BLS', 'ALS']),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const ambulance = await ambulanceService.createAmbulance(req.body);
      res.status(201).json({ ambulance });
    } catch (err) {
      const mapped = mapDbError(err);
      if (mapped) return res.status(mapped.status).json({ error: mapped.message });
      next(err);
    }
  }
);

router.get('/ambulances', requireRole(ROLES.ADMIN), async (req, res, next) => {
  try {
    const { providerId, status } = req.query;
    res.json({ ambulances: await ambulanceService.list({ providerId, status }) });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/ambulances/:id',
  requireRole(ROLES.ADMIN),
  param('id').isInt(),
  body('providerId').optional().isInt(),
  body('callSign').optional().isString().trim().notEmpty(),
  body('capabilityLevel').optional().isIn(['BLS', 'ALS']),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const ambulance = await ambulanceService.updateAmbulance(req.params.id, req.body);
      if (!ambulance) return res.status(404).json({ error: 'Ambulance not found' });
      res.json({ ambulance });
    } catch (err) {
      const mapped = mapDbError(err);
      if (mapped) return res.status(mapped.status).json({ error: mapped.message });
      next(err);
    }
  }
);

router.patch(
  '/ambulances/:id/active',
  requireRole(ROLES.ADMIN),
  param('id').isInt(),
  body('active').isBoolean(),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const ambulance = await ambulanceService.setActive(req.params.id, req.body.active);
      if (!ambulance) return res.status(404).json({ error: 'Ambulance not found' });
      res.json({ ambulance });
    } catch (err) {
      next(err);
    }
  }
);

// Response-time analytics, computed from real incident_events timestamps
// -- the evidence behind Objective v's benchmark evaluation.
router.get('/analytics', requireRole(ROLES.ADMIN), async (_req, res, next) => {
  try {
    res.json(await analyticsService.getSummary());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
