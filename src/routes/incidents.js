const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const pool = require('../config/db');
const incidentService = require('../services/incidentService');
const triageService = require('../services/triageService');
const dispatchService = require('../services/dispatchService');
const auditService = require('../services/auditService');
const routingService = require('../services/routingService');
const ambulanceService = require('../services/ambulanceService');
const hospitalService = require('../services/hospitalService');
const missionMessageService = require('../services/missionMessageService');
const preArrivalInstructionsService = require('../services/preArrivalInstructionsService');
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

// Must be registered before GET '/:id' -- same reason as '/mine' above.
// Advisory duplicate-call check, run against the pending pin location
// before an incident is actually created (see incidentService.findNearbyOpen).
router.get(
  '/nearby-open',
  requireRole(ROLES.DISPATCHER, ROLES.ADMIN),
  query('lat').isFloat({ min: -90, max: 90 }),
  query('lng').isFloat({ min: -180, max: 180 }),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const incidents = await incidentService.findNearbyOpen(Number(req.query.lat), Number(req.query.lng));
      res.json({ incidents });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/:id', requireRole(ROLES.DISPATCHER, ROLES.ADMIN), async (req, res, next) => {
  try {
    const incident = await incidentService.findById(req.params.id);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    res.json({ incident });
  } catch (err) {
    next(err);
  }
});

// The full non-repudiation audit trail for this incident (proposal Sec 5) --
// every dispatch decision, status change, and notification event, in
// order. Dispatcher/admin only, same as the incident record itself; this
// is an operational/audit view, not something crew or hospital roles need.
router.get(
  '/:id/events',
  requireRole(ROLES.DISPATCHER, ROLES.ADMIN),
  param('id').isInt(),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const incident = await incidentService.findById(req.params.id);
      if (!incident) return res.status(404).json({ error: 'Incident not found' });
      res.json({ events: await auditService.getTimeline(req.params.id) });
    } catch (err) {
      next(err);
    }
  }
);

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

// Live ETA for the dispatcher-facing map, recomputed on demand from the
// assigned ambulance's current GPS position -- unlike hospital_notifications'
// eta_snapshot_seconds (a one-time value taken at the moment transport
// started), this reflects wherever the ambulance actually is right now, so
// polling this endpoint gives a countdown that genuinely ticks down rather
// than a number frozen at dispatch/transport time. Destination is the
// incident scene until transport begins, then switches to the assigned
// hospital -- mirrors the same before/after-transport distinction
// dispatchService.updateMissionStatus already encodes in incident.status.
const ETA_TARGETS_SCENE = ['assigned', 'dispatched', 'en_route', 'on_scene'];

router.get('/:id/eta', requireRole(ROLES.DISPATCHER, ROLES.ADMIN), param('id').isInt(), async (req, res, next) => {
  if (!handleValidation(req, res)) return;
  try {
    const incident = await incidentService.findById(req.params.id);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    if (!incident.assigned_ambulance_id) {
      return res.status(409).json({ error: 'No ambulance assigned to this incident yet' });
    }

    const ambulance = await ambulanceService.findById(incident.assigned_ambulance_id);
    if (!ambulance || ambulance.lat === null || ambulance.lng === null) {
      return res.status(409).json({ error: 'Ambulance has no known position yet' });
    }

    let destination;
    let target;
    if (ETA_TARGETS_SCENE.includes(incident.status)) {
      destination = { lat: incident.lat, lng: incident.lng };
      target = 'incident';
    } else if (incident.status === 'transporting') {
      if (!incident.assigned_hospital_id) {
        return res.status(409).json({ error: 'No destination hospital set yet' });
      }
      const hospital = await hospitalService.findById(incident.assigned_hospital_id);
      if (!hospital) return res.status(409).json({ error: 'Destination hospital not found' });
      destination = { lat: hospital.lat, lng: hospital.lng };
      target = 'hospital';
    } else {
      return res.status(409).json({ error: `ETA not applicable for status '${incident.status}'` });
    }

    const route = await routingService.getRoute({ lat: ambulance.lat, lng: ambulance.lng }, destination);
    res.json({ etaSeconds: Math.round(route.durationSeconds), distanceMeters: route.distanceMeters, target });
  } catch (err) {
    if (err instanceof routingService.OsrmUnavailableError) {
      return res.status(503).json({ error: 'Routing service unavailable' });
    }
    next(err);
  }
});

// Message history for the crew<->dispatcher chat channel (see
// sockets/index.js's 'mission:message' handler, which persists new
// messages). Dispatchers/admins can read any incident's history; crew can
// only read the history of the incident currently assigned to their own
// ambulance, same restriction as GET /:id/route.
router.get(
  '/:id/messages',
  requireRole(ROLES.DISPATCHER, ROLES.ADMIN, ROLES.CREW),
  param('id').isInt(),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const incident = await incidentService.findById(req.params.id);
      if (!incident) return res.status(404).json({ error: 'Incident not found' });

      if (req.session.user.role === ROLES.CREW) {
        const ambulanceId = await findCurrentAmbulanceForCrew(req.session.user.id);
        if (!ambulanceId || incident.assigned_ambulance_id !== ambulanceId) {
          return res.status(403).json({ error: 'This incident is not assigned to your ambulance' });
        }
      }

      res.json({ messages: await missionMessageService.listForIncident(req.params.id) });
    } catch (err) {
      next(err);
    }
  }
);

// Pre-arrival instructions (see plan: "Pre-arrival instructions reference
// card") -- generic lay-rescuer first-aid steps for the dispatcher to read
// to the caller while the ambulance is en route, derived from this
// incident's own recorded chief complaint/red flags rather than a
// separately-entered value, so it always matches what was actually triaged.
router.get(
  '/:id/pre-arrival-instructions',
  requireRole(ROLES.DISPATCHER, ROLES.ADMIN),
  param('id').isInt(),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const incident = await incidentService.findById(req.params.id);
      if (!incident) return res.status(404).json({ error: 'Incident not found' });
      const redFlags = typeof incident.red_flags === 'string' ? JSON.parse(incident.red_flags) : incident.red_flags;
      res.json(preArrivalInstructionsService.getInstructions(incident.chief_complaint, redFlags));
    } catch (err) {
      next(err);
    }
  }
);

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

// Mid-incident priority re-triage (see plan: "Mid-incident priority
// escalation") -- distinct from the initial triage suggestion/override at
// creation time. A reason is required so the audit trail always shows why
// urgency changed mid-response, not just that it did.
router.post(
  '/:id/priority',
  requireRole(ROLES.DISPATCHER, ROLES.ADMIN),
  param('id').isInt(),
  body('priority').isIn(triageService.PRIORITIES),
  body('reason').isString().trim().isLength({ min: 3 }),
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;
    try {
      const incident = await dispatchService.escalatePriority(
        req.params.id,
        req.session.user.id,
        req.body.priority,
        req.body.reason
      );
      res.json({ incident });
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
