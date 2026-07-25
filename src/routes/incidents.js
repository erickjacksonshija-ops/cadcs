const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const pool = require('../config/db');
const incidentService = require('../services/incidentService');
const triageService = require('../services/triageService');
const dispatchService = require('../services/dispatchService');
const routingService = require('../services/routingService');
const ambulanceService = require('../services/ambulanceService');
const { serializeIncidentForRole } = require('../services/incidentSerializer');
const { findCurrentAmbulanceForCrew } = require('../sockets/rooms');
const requireRole = require('../middleware/requireRole');
const { ROLES } = require('../config/roles');

const router = express.Router();

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'Invalid input', details: errors.array() });
    return false;
  }
  return true;
}

// Only dispatchers (and admins, for testing/support) create incidents --
// this is the dispatcher's own click-to-pin + triage-checklist workflow,
// not a public intake form (see "Account Provisioning" / no public
// self-registration in the plan -- the same principle applies to incident
// creation, which is a controlled operational action, not a public form).
router.post(
  '/',
  requireRole(ROLES.DISPATCHER, ROLES.ADMIN),
  body('lat').isFloat({ min: -90, max: 90 }),
  body('lng').isFloat({ min: -180, max: 180 }),
  body('locationDescription').optional().isString(),
  body('callerPhone').optional().isString(),
  body('chiefComplaint').isIn(triageService.CHIEF_COMPLAINTS),
  body('redFlags').optional().isObject(),
  body('priorityOverride').optional().isIn(triageService.PRIORITIES),
  body('capabilityOverride').optional().isIn(['BLS', 'ALS']),
  body('patientNotes').optional().isString(),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const incident = await incidentService.createIncident({
        ...req.body,
        createdBy: req.session.user.id,
      });
      res.status(201).json({ incident });
    } catch (err) {
      if (err instanceof incidentService.ValidationError) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  }
);

router.get(
  '/',
  requireRole(ROLES.DISPATCHER, ROLES.ADMIN),
  query('status').optional().isString(),
  query('active').optional().isBoolean(),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      res.json({
        incidents: await incidentService.list({
          status: req.query.status,
          activeOnly: req.query.active === 'true',
        }),
      });
    } catch (err) {
      next(err);
    }
  }
);

// Must be registered before GET '/:id' -- otherwise Express would match
// '/mine' as :id='mine'. The crew's current mission, field-filtered via
// the role-aware serializer (no patient_notes/caller_phone for crew).
router.get('/mine', requireRole(ROLES.CREW), async (req, res, next) => {
  try {
    const ambulanceId = await findCurrentAmbulanceForCrew(req.session.user.id);
    if (!ambulanceId) return res.json({ incident: null });

    const [incidents] = await pool.query(
      `SELECT id FROM incidents WHERE assigned_ambulance_id = :ambulanceId
       AND status NOT IN ('closed', 'cancelled') ORDER BY reported_at DESC LIMIT 1`,
      { ambulanceId }
    );
    if (incidents.length === 0) return res.json({ incident: null });

    const incident = await incidentService.findById(incidents[0].id);
    res.json({ incident: serializeIncidentForRole(incident, ROLES.CREW) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireRole(ROLES.DISPATCHER, ROLES.ADMIN), async (req, res, next) => {
  try {
    const incident = await incidentService.findById(req.params.id);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    res.json({ incident });
  } catch (err) {
    next(err);
  }
});

// Ranked ambulance candidates for this incident (real road-network ETA via
// OSRM, or a flagged Haversine fallback if OSRM is unreachable). Read-only
// -- does not assign anything.
router.get(
  '/:id/candidates',
  requireRole(ROLES.DISPATCHER, ROLES.ADMIN),
  param('id').isInt(),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const result = await dispatchService.rankCandidates(req.params.id);
      res.json(result);
    } catch (err) {
      if (err instanceof dispatchService.ValidationError) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  }
);

// Ranked destination-hospital candidates for the crew's transport picker
// (real road-network ETA from the ambulance's current position, or a
// flagged Haversine fallback if OSRM is unreachable) -- mirrors
// /:id/candidates' ranking philosophy, applied to hospital selection
// instead of ambulance selection. Read-only -- does not set the incident's
// destination hospital.
router.get(
  '/:id/hospitals',
  requireRole(ROLES.CREW),
  param('id').isInt(),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const ambulanceId = await findCurrentAmbulanceForCrew(req.session.user.id);
      if (!ambulanceId) return res.status(403).json({ error: 'You have no assigned ambulance' });

      const incident = await incidentService.findById(req.params.id);
      if (!incident) return res.status(404).json({ error: 'Incident not found' });
      if (incident.assigned_ambulance_id !== ambulanceId) {
        return res.status(403).json({ error: 'This incident is not assigned to your ambulance' });
      }

      const result = await dispatchService.rankHospitals(req.params.id);
      res.json(result);
    } catch (err) {
      if (err instanceof dispatchService.ValidationError) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  }
);

// Confirms dispatch of a specific ambulance -- the dispatcher's decision,
// informed by (but not bound to) the ranked candidate list. Atomic
// compare-and-swap under the hood (see dispatchService) so two dispatchers
// can never double-book the same unit.
router.post(
  '/:id/assign',
  requireRole(ROLES.DISPATCHER, ROLES.ADMIN),
  param('id').isInt(),
  body('ambulanceId').isInt(),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const incident = await dispatchService.assignAmbulance(
        req.params.id,
        req.body.ambulanceId,
        req.session.user.id
      );
      res.json({ incident });
    } catch (err) {
      if (err instanceof dispatchService.ValidationError || err instanceof dispatchService.ConflictError) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  }
);

// Turn-by-turn route geometry + ETA for the crew PWA's navigation view --
// only for the crew member currently assigned to this specific incident's
// ambulance, using that ambulance's live GPS position as the origin.
router.get('/:id/route', requireRole(ROLES.CREW), param('id').isInt(), async (req, res, next) => {
  if (!handleValidation(req, res)) return;
  try {
    const ambulanceId = await findCurrentAmbulanceForCrew(req.session.user.id);
    if (!ambulanceId) return res.status(403).json({ error: 'You have no assigned ambulance' });

    const incident = await incidentService.findById(req.params.id);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    if (incident.assigned_ambulance_id !== ambulanceId) {
      return res.status(403).json({ error: 'This incident is not assigned to your ambulance' });
    }

    const ambulance = await ambulanceService.findById(ambulanceId);
    if (ambulance.lat === null || ambulance.lng === null) {
      return res.status(409).json({ error: 'Ambulance has no known position yet -- send a GPS ping first' });
    }

    const route = await routingService.getRoute(
      { lat: ambulance.lat, lng: ambulance.lng },
      { lat: incident.lat, lng: incident.lng }
    );
    res.json({ route });
  } catch (err) {
    if (err instanceof routingService.OsrmUnavailableError) {
      return res.status(503).json({ error: 'Routing service unavailable' });
    }
    next(err);
  }
});

// Crew-initiated status update (never GPS-inferred -- see dispatchService).
router.post(
  '/:id/status',
  requireRole(ROLES.CREW),
  param('id').isInt(),
  body('status').isIn(Object.values(dispatchService.CREW_STATUS_TRANSITIONS)),
  body('hospitalId').optional().isInt(),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const incident = await dispatchService.updateMissionStatus(
        req.params.id,
        req.session.user.id,
        req.body.status,
        req.body.hospitalId
      );
      res.json({ incident: serializeIncidentForRole(incident, ROLES.CREW) });
    } catch (err) {
      if (err instanceof dispatchService.ValidationError) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  }
);

// Dispatcher/admin only -- covers false alarms and duplicate reports (see
// dispatchService.cancelIncident for the exact rules on when this is
// allowed).
router.post(
  '/:id/cancel',
  requireRole(ROLES.DISPATCHER, ROLES.ADMIN),
  param('id').isInt(),
  body('reason').isString().trim().isLength({ min: 3 }),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const incident = await dispatchService.cancelIncident(req.params.id, req.session.user.id, req.body.reason);
      res.json({ incident });
    } catch (err) {
      if (err instanceof dispatchService.ValidationError) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  }
);

module.exports = router;
