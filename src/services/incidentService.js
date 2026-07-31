const pool = require('../config/db');
const { POINT_SQL, latLngColumns } = require('./geo');
const triageService = require('./triageService');
const auditService = require('./auditService');
const { tryGetIo } = require('../sockets/ioRegistry');
const { DISPATCHERS_ROOM } = require('../sockets/rooms');

const SELECT_COLUMNS = `
  id, reported_at, caller_phone, ${latLngColumns('location')}, location_description,
  chief_complaint, red_flags, suggested_priority, suggested_capability,
  priority, required_capability, patient_notes, status, cancel_reason,
  assigned_ambulance_id, assigned_hospital_id, created_by, closed_at, created_at
`;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

// Creates an incident and its opening audit trail entries as one atomic
// unit -- either the incident and its "created"/"triage_suggested" (and
// "priority_overridden" if applicable) events all land together, or none
// of them do. A partially-recorded incident (row exists, audit trail
// doesn't) would undermine the non-repudiation guarantee the whole
// incident_events design exists for.
async function createIncident({
  callerPhone,
  lat,
  lng,
  locationDescription,
  chiefComplaint,
  redFlags,
  priorityOverride,
  capabilityOverride,
  patientNotes,
  createdBy,
}) {
  const suggestion = triageService.classify(chiefComplaint, redFlags);
  const finalPriority = priorityOverride || suggestion.priority;
  const finalCapability = capabilityOverride || suggestion.capability;

  if (!triageService.PRIORITIES.includes(finalPriority)) {
    throw new ValidationError(`Invalid priority: ${finalPriority}`);
  }
  if (!['BLS', 'ALS'].includes(finalCapability)) {
    throw new ValidationError(`Invalid capability: ${finalCapability}`);
  }

  const normalizedRedFlags = triageService.normalizeRedFlags(redFlags);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      `INSERT INTO incidents (
         caller_phone, location, location_description, chief_complaint, red_flags,
         suggested_priority, suggested_capability, priority, required_capability,
         patient_notes, created_by
       ) VALUES (
         :callerPhone, ${POINT_SQL}, :locationDescription, :chiefComplaint, :redFlags,
         :suggestedPriority, :suggestedCapability, :priority, :requiredCapability,
         :patientNotes, :createdBy
       )`,
      {
        callerPhone: callerPhone || null,
        lat,
        lng,
        locationDescription: locationDescription || null,
        chiefComplaint,
        redFlags: JSON.stringify(normalizedRedFlags),
        suggestedPriority: suggestion.priority,
        suggestedCapability: suggestion.capability,
        priority: finalPriority,
        requiredCapability: finalCapability,
        patientNotes: patientNotes || null,
        createdBy,
      }
    );

    const incidentId = result.insertId;

    await auditService.logEvent(incidentId, 'created', {
      actorUserId: createdBy,
      metadata: { chiefComplaint, redFlags: normalizedRedFlags, locationDescription },
      connection: conn,
    });
    await auditService.logEvent(incidentId, 'triage_suggested', {
      metadata: suggestion,
      connection: conn,
    });
    if (finalPriority !== suggestion.priority || finalCapability !== suggestion.capability) {
      await auditService.logEvent(incidentId, 'priority_overridden', {
        actorUserId: createdBy,
        metadata: { suggestion, chosen: { priority: finalPriority, capability: finalCapability } },
        connection: conn,
      });
    }

    await conn.commit();
    const incident = await findById(incidentId);

    // Every dispatcher's map/list needs to see a new incident immediately,
    // not just the one who created it -- this is the whole point of
    // cross-provider, multi-dispatcher shared visibility.
    const io = tryGetIo();
    if (io) io.to(DISPATCHERS_ROOM).emit('incident:created', incident);

    return incident;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function findById(id) {
  const [rows] = await pool.query(`SELECT ${SELECT_COLUMNS} FROM incidents WHERE id = :id LIMIT 1`, { id });
  return rows[0] || null;
}

// Open incidents reported near this location in the last few minutes -- the
// concrete fix for the single most common real 911 operational problem:
// several different callers reporting the same scene (a crash, a fire)
// getting treated as separate incidents and double-dispatched. Advisory
// only -- the dispatcher decides whether it's a genuine duplicate or a
// second, distinct call that happens to be nearby.
async function findNearbyOpen(lat, lng, { withinMeters = 300, withinMinutes = 20 } = {}) {
  const [rows] = await pool.query(
    `SELECT id, priority, chief_complaint, location_description, status, reported_at,
            ST_Distance_Sphere(location, ${POINT_SQL}) AS distance_meters
     FROM incidents
     WHERE status NOT IN ('closed', 'cancelled')
       AND reported_at >= DATE_SUB(NOW(), INTERVAL :withinMinutes MINUTE)
       HAVING distance_meters <= :withinMeters
     ORDER BY distance_meters ASC`,
    { lat, lng, withinMinutes, withinMeters }
  );
  return rows;
}

// The mission an ambulance is currently on, if any -- same "not yet closed/
// cancelled" scoping as routes/incidents.js's GET /mine. Used by the
// mission-chat socket handler to resolve which incident a crew<->dispatcher
// message attaches to from just an ambulanceId.
async function findActiveByAmbulanceId(ambulanceId) {
  const [rows] = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM incidents
     WHERE assigned_ambulance_id = :ambulanceId AND status NOT IN ('closed', 'cancelled')
     ORDER BY reported_at DESC LIMIT 1`,
    { ambulanceId }
  );
  return rows[0] || null;
}

// activeOnly: everything the dispatcher should still be tracking on the
// live board -- not just 'reported'/'assigned', but all the way through
// the crew-driven lifecycle (en_route/on_scene/transporting/at_hospital)
// until it's actually closed or cancelled. Without this, an incident
// silently vanishes from the dispatcher's list the moment a crew member
// updates its status past "assigned" -- caught via manual browser testing.
async function list({ status, activeOnly } = {}) {
  let where = '';
  const params = {};
  if (status) {
    where = 'WHERE status = :status';
    params.status = status;
  } else if (activeOnly) {
    where = "WHERE status NOT IN ('closed', 'cancelled')";
  }
  const [rows] = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM incidents ${where} ORDER BY reported_at DESC`,
    params
  );
  return rows;
}

module.exports = { createIncident, findById, findActiveByAmbulanceId, findNearbyOpen, list, ValidationError };
