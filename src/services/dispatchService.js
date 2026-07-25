const pool = require('../config/db');
const { latLngColumns } = require('./geo');
const routingService = require('./routingService');
const auditService = require('./auditService');
const incidentService = require('./incidentService');
const notificationService = require('./notificationService');
const { tryGetIo } = require('../sockets/ioRegistry');
const { DISPATCHERS_ROOM, crewRoom, hospitalRoom } = require('../sockets/rooms');
const { serializeIncidentForRole } = require('./incidentSerializer');
const { ROLES } = require('../config/roles');

// Crew-initiated only -- deliberately NOT GPS/geofence-inferred (device
// accuracy varies too much to drive state transitions off it; see plan's
// "Reliability & Failure Handling"). Maps each ambulance status to the
// only status a crew is allowed to move it to next, so a crew can't skip
// steps or submit an arbitrary status. incidents.status mirrors
// ambulances.status for these shared-vocabulary states; 'assigned' (the
// dispatcher's initial claim) and 'closed' (mission complete, ambulance
// freed back to 'available') are the two points where the two tables'
// meanings diverge.
const CREW_STATUS_TRANSITIONS = {
  dispatched: 'en_route',
  en_route: 'on_scene',
  on_scene: 'transporting',
  transporting: 'at_hospital',
  at_hospital: 'closed',
};

// Cheap pre-filter size before the (more expensive, network-call) OSRM
// ranking step -- see plan's "Dispatch Algorithm" section.
const PRE_FILTER_LIMIT = 8;

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.status = 409;
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

// ALS is a superset of BLS capability in real EMS practice -- an ALS unit
// can always handle a BLS-level call, but a BLS unit cannot handle a call
// that requires ALS. So: incident requires ALS -> only ALS ambulances
// qualify; incident requires BLS -> both ALS and BLS ambulances qualify.
async function preFilterCandidates(incidentLat, incidentLng, requiredCapability) {
  const [rows] = await pool.query(
    `SELECT a.id, a.provider_id, a.call_sign, a.capability_level,
       ${latLngColumns('a.current_location')},
       ST_Distance_Sphere(a.current_location, ST_SRID(POINT(:lat, :lng), 4326)) AS haversine_meters
     FROM ambulances a
     WHERE a.status = 'available' AND a.active = 1 AND a.current_location IS NOT NULL
       AND (a.capability_level = 'ALS' OR a.capability_level = :requiredCapability)
     ORDER BY haversine_meters ASC
     LIMIT ${PRE_FILTER_LIMIT}`,
    { lat: incidentLat, lng: incidentLng, requiredCapability }
  );
  return rows;
}

// Returns a ranked list of candidate ambulances for an incident, without
// assigning anything -- the dispatcher reviews and confirms (see plan:
// "the algorithm recommends, the dispatcher confirms"). Falls back to
// Haversine-only ranking, with a flag the API surfaces to the dispatcher,
// if OSRM is unreachable -- never throws just because OSRM is down.
async function rankCandidates(incidentId) {
  const incident = await incidentService.findById(incidentId);
  if (!incident) throw new ValidationError('Incident not found');

  const preFiltered = await preFilterCandidates(incident.lat, incident.lng, incident.required_capability);
  if (preFiltered.length === 0) {
    return { candidates: [], routingSource: 'none' };
  }

  let routingSource = 'osrm';
  let candidates;
  try {
    const routed = await routingService.getDurationsAndDistances(
      { lat: incident.lat, lng: incident.lng },
      preFiltered.map((c) => ({ lat: c.lat, lng: c.lng }))
    );
    candidates = preFiltered
      .map((c, i) => ({
        ambulanceId: c.id,
        providerId: c.provider_id,
        callSign: c.call_sign,
        capabilityLevel: c.capability_level,
        etaSeconds: routed[i].durationSeconds,
        distanceMeters: routed[i].distanceMeters,
      }))
      .sort((a, b) => a.etaSeconds - b.etaSeconds);
  } catch (err) {
    if (!(err instanceof routingService.OsrmUnavailableError)) throw err;
    // Road-routing unavailable -- fall back to the Haversine pre-filter's
    // straight-line distances rather than fail the whole dispatch flow.
    // The dispatcher UI must show this degraded state, not hide it.
    routingSource = 'haversine_fallback';
    candidates = preFiltered
      .map((c) => ({
        ambulanceId: c.id,
        providerId: c.provider_id,
        callSign: c.call_sign,
        capabilityLevel: c.capability_level,
        etaSeconds: null,
        distanceMeters: c.haversine_meters,
      }))
      .sort((a, b) => a.distanceMeters - b.distanceMeters);
  }

  await auditService.logEvent(incidentId, 'candidates_ranked', {
    metadata: { routingSource, candidates },
  });

  return { candidates, routingSource };
}

// Atomic compare-and-swap: an ambulance can only be assigned if it is
// still 'available' at the moment of the UPDATE, so two dispatchers acting
// on simultaneous incidents can never both win the same unit (see plan:
// "Concurrency & Correctness Guarantees"). Rejects (rather than silently
// no-ops) if the ambulance was already taken, or the incident is no longer
// in a state that can be assigned.
async function assignAmbulance(incidentId, ambulanceId, dispatcherUserId) {
  const incident = await incidentService.findById(incidentId);
  if (!incident) throw new ValidationError('Incident not found');

  const [[ambulance]] = await pool.query(
    'SELECT id, capability_level FROM ambulances WHERE id = :ambulanceId LIMIT 1',
    { ambulanceId }
  );
  if (!ambulance) throw new ValidationError('Ambulance not found');

  // The dispatcher has discretion over which candidate to pick (local
  // knowledge, etc) -- but never discretion to send a BLS-only unit to a
  // call that requires ALS. Same ALS-is-a-superset-of-BLS rule as the
  // pre-filter.
  const capabilityOk =
    ambulance.capability_level === 'ALS' || ambulance.capability_level === incident.required_capability;
  if (!capabilityOk) {
    throw new ValidationError(
      `Ambulance capability (${ambulance.capability_level}) does not meet the incident's required capability (${incident.required_capability})`
    );
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [ambulanceUpdate] = await conn.query(
      `UPDATE ambulances SET status = 'dispatched' WHERE id = :ambulanceId AND status = 'available'`,
      { ambulanceId }
    );
    if (ambulanceUpdate.affectedRows === 0) {
      await auditService.logEvent(incidentId, 'assignment_rejected_conflict', {
        actorUserId: dispatcherUserId,
        metadata: { ambulanceId, reason: 'ambulance no longer available' },
        connection: conn,
      });
      await conn.commit();
      throw new ConflictError('That ambulance is no longer available -- pick another candidate');
    }

    const [incidentUpdate] = await conn.query(
      `UPDATE incidents SET assigned_ambulance_id = :ambulanceId, status = 'assigned'
       WHERE id = :incidentId AND status = 'reported'`,
      { ambulanceId, incidentId }
    );
    if (incidentUpdate.affectedRows === 0) {
      // Incident already assigned/closed/cancelled by someone else in the
      // meantime -- roll back the ambulance claim too, it shouldn't be
      // consumed for an assignment that isn't actually happening.
      await conn.rollback();
      throw new ConflictError('Incident is no longer awaiting assignment');
    }

    await auditService.logEvent(incidentId, 'assigned', {
      actorUserId: dispatcherUserId,
      metadata: { ambulanceId },
      connection: conn,
    });

    await conn.commit();
    const updatedIncident = await incidentService.findById(incidentId);

    const io = tryGetIo();
    if (io) {
      io.to(DISPATCHERS_ROOM).emit('incident:assigned', updatedIncident);
      // The crew needs to see their new mission pushed instantly, not
      // discover it by refreshing -- this is the "Mission Control"
      // requirement (instantaneous dispatch, no manual reloads). Uses the
      // same role-aware serializer as GET /mine so the pushed payload
      // never contains patient_notes/caller_phone either.
      io.to(crewRoom(ambulanceId)).emit('mission:assigned', serializeIncidentForRole(updatedIncident, ROLES.CREW));
    }

    return updatedIncident;
  } catch (err) {
    if (!(err instanceof ConflictError)) {
      await conn.rollback();
    }
    throw err;
  } finally {
    conn.release();
  }
}

// Crew taps a status button in the PWA; this validates and applies the one
// legal next transition, row-locking both the incident and ambulance
// (SELECT ... FOR UPDATE) so a rapid double-tap can't apply two
// transitions at once, same correctness discipline as assignAmbulance's
// compare-and-swap.
async function updateMissionStatus(incidentId, crewUserId, targetStatus, hospitalId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[incident]] = await conn.query(
      'SELECT id, status, assigned_ambulance_id FROM incidents WHERE id = :incidentId FOR UPDATE',
      { incidentId }
    );
    if (!incident || !incident.assigned_ambulance_id) {
      throw new ValidationError('Incident has no assigned ambulance');
    }

    const [[ambulance]] = await conn.query(
      `SELECT id, status, current_crew_user_id, ${latLngColumns('current_location')}
       FROM ambulances WHERE id = :id FOR UPDATE`,
      { id: incident.assigned_ambulance_id }
    );
    if (!ambulance || ambulance.current_crew_user_id !== crewUserId) {
      throw new ValidationError('You are not the crew currently assigned to this incident');
    }

    const allowedNext = CREW_STATUS_TRANSITIONS[ambulance.status];
    if (!allowedNext || allowedNext !== targetStatus) {
      throw new ValidationError(
        `Cannot transition from '${ambulance.status}' to '${targetStatus}' -- next allowed status is '${allowedNext || 'none'}'`
      );
    }

    // Hospital selection and pre-notification happen at the moment
    // transport actually starts -- that's the earliest point a
    // destination and a meaningful ETA both genuinely exist (see
    // notificationService for the full rationale).
    let notificationResult = null;
    if (targetStatus === 'transporting') {
      if (!hospitalId) throw new ValidationError('hospitalId is required when starting transport');
      if (ambulance.lat === null || ambulance.lng === null) {
        throw new ValidationError('Ambulance has no known position yet -- send a GPS ping first');
      }
      await conn.query('UPDATE incidents SET assigned_hospital_id = :hospitalId WHERE id = :incidentId', {
        hospitalId,
        incidentId,
      });
      notificationResult = await notificationService.sendPreNotification(
        incidentId,
        hospitalId,
        { lat: ambulance.lat, lng: ambulance.lng },
        conn
      );
    }

    if (targetStatus === 'closed') {
      await conn.query("UPDATE ambulances SET status = 'available' WHERE id = :id", { id: ambulance.id });
      await conn.query(
        "UPDATE incidents SET status = 'closed', closed_at = NOW() WHERE id = :id",
        { id: incidentId }
      );
      await auditService.logEvent(incidentId, 'closed', {
        actorUserId: crewUserId,
        metadata: { finalAmbulanceStatus: 'available' },
        connection: conn,
      });
    } else {
      await conn.query('UPDATE ambulances SET status = :status WHERE id = :id', {
        status: targetStatus,
        id: ambulance.id,
      });
      await conn.query('UPDATE incidents SET status = :status WHERE id = :id', {
        status: targetStatus,
        id: incidentId,
      });
      await auditService.logEvent(incidentId, 'status_changed', {
        actorUserId: crewUserId,
        metadata: { from: ambulance.status, to: targetStatus },
        connection: conn,
      });
    }

    await conn.commit();
    const updatedIncident = await incidentService.findById(incidentId);

    const io = tryGetIo();
    if (io) {
      io.to(DISPATCHERS_ROOM).emit('ambulance:status_changed', {
        ambulanceId: ambulance.id,
        incidentId,
        status: targetStatus === 'closed' ? 'available' : targetStatus,
      });

      if (notificationResult) {
        io.to(hospitalRoom(hospitalId)).emit('hospital:notified', {
          notificationId: notificationResult.notificationId,
          etaSeconds: notificationResult.etaSeconds,
          incident: serializeIncidentForRole(updatedIncident, ROLES.HOSPITAL_STAFF),
        });
      }
    }

    return updatedIncident;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Covers the real-world "false alarm" / "duplicate report" / "caller
// called back" cases -- allowed only before a crew has actively committed
// to responding (status 'reported' or 'assigned'; once en_route or later,
// a live recall is a different, more involved real-world action than a
// desk cancellation and is out of scope here). Releases any claimed
// ambulance back to 'available' rather than leaving it stuck.
async function cancelIncident(incidentId, dispatcherUserId, reason) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[incident]] = await conn.query(
      'SELECT id, status, assigned_ambulance_id FROM incidents WHERE id = :incidentId FOR UPDATE',
      { incidentId }
    );
    if (!incident) throw new ValidationError('Incident not found');
    if (!['reported', 'assigned'].includes(incident.status)) {
      throw new ValidationError(
        `Cannot cancel an incident with status '${incident.status}' -- a crew is already actively responding`
      );
    }

    await conn.query(
      "UPDATE incidents SET status = 'cancelled', cancel_reason = :reason, closed_at = NOW() WHERE id = :incidentId",
      { reason, incidentId }
    );

    if (incident.assigned_ambulance_id) {
      await conn.query("UPDATE ambulances SET status = 'available' WHERE id = :id", {
        id: incident.assigned_ambulance_id,
      });
    }

    await auditService.logEvent(incidentId, 'cancelled', {
      actorUserId: dispatcherUserId,
      metadata: { reason, hadAssignedAmbulance: Boolean(incident.assigned_ambulance_id) },
      connection: conn,
    });

    await conn.commit();
    const updatedIncident = await incidentService.findById(incidentId);

    const io = tryGetIo();
    if (io) {
      io.to(DISPATCHERS_ROOM).emit('incident:cancelled', updatedIncident);
      if (incident.assigned_ambulance_id) {
        io.to(crewRoom(incident.assigned_ambulance_id)).emit('mission:cancelled', { incidentId });
      }
    }

    return updatedIncident;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  rankCandidates,
  assignAmbulance,
  updateMissionStatus,
  cancelIncident,
  ConflictError,
  ValidationError,
  PRE_FILTER_LIMIT,
  CREW_STATUS_TRANSITIONS,
};
