const pool = require('../config/db');
const routingService = require('./routingService');
const auditService = require('./auditService');

// Sent when a crew starts transporting a patient (see dispatchService --
// this is when a receiving hospital and a meaningful ETA both actually
// exist; pre-notifying at initial scene dispatch would mean guessing an
// ETA before the patient has even been picked up). Runs inside the same
// transaction as the status update (via `connection`), so the
// notification row and the "transporting" status change are always
// consistent together. Does NOT broadcast here -- the caller
// (dispatchService) does that after the transaction commits, using
// incidentService.findById for a properly-shaped (lat/lng-aliased, not a
// raw geometry blob) incident payload, matching the pattern already used
// for incident:created/incident:assigned.
async function sendPreNotification(incidentId, hospitalId, originLatLng, connection) {
  const conn = connection || pool;

  let etaSeconds = null;
  try {
    const [hospitalRows] = await conn.query(
      'SELECT ST_Y(location) AS lat, ST_X(location) AS lng FROM hospitals WHERE id = :hospitalId LIMIT 1',
      { hospitalId }
    );
    const hospital = hospitalRows[0];
    if (hospital) {
      const route = await routingService.getRoute(originLatLng, { lat: hospital.lat, lng: hospital.lng });
      etaSeconds = Math.round(route.durationSeconds);
    }
  } catch (err) {
    if (!(err instanceof routingService.OsrmUnavailableError)) throw err;
    // OSRM down -- send the notification anyway with no ETA rather than
    // block the hospital from being alerted at all.
  }

  const [result] = await conn.query(
    `INSERT INTO hospital_notifications (incident_id, hospital_id, eta_snapshot_seconds)
     VALUES (:incidentId, :hospitalId, :etaSeconds)`,
    { incidentId, hospitalId, etaSeconds }
  );

  await auditService.logEvent(incidentId, 'hospital_notified', {
    metadata: { hospitalId, etaSeconds },
    connection: conn,
  });

  return { notificationId: result.insertId, etaSeconds };
}

async function acknowledge(notificationId, hospitalId, ackByUserId) {
  const [result] = await pool.query(
    `UPDATE hospital_notifications
     SET acknowledged_at = NOW(3), acknowledged_by = :ackByUserId
     WHERE id = :notificationId AND hospital_id = :hospitalId AND acknowledged_at IS NULL`,
    { notificationId, hospitalId, ackByUserId }
  );
  if (result.affectedRows === 0) return null;

  const [[notification]] = await pool.query('SELECT * FROM hospital_notifications WHERE id = :notificationId', {
    notificationId,
  });

  await auditService.logEvent(notification.incident_id, 'hospital_acknowledged', {
    actorUserId: ackByUserId,
    metadata: { notificationId, hospitalId },
  });

  return notification;
}

async function listForHospital(hospitalId) {
  const [rows] = await pool.query(
    `SELECT hn.id, hn.incident_id, hn.sent_at, hn.eta_snapshot_seconds, hn.acknowledged_at, hn.escalated_at,
            i.priority, i.required_capability, i.chief_complaint, i.location_description, i.patient_notes, i.status,
            a.call_sign AS ambulance_call_sign, a.capability_level AS ambulance_capability_level
     FROM hospital_notifications hn
     JOIN incidents i ON i.id = hn.incident_id
     LEFT JOIN ambulances a ON a.id = i.assigned_ambulance_id
     WHERE hn.hospital_id = :hospitalId
     ORDER BY hn.sent_at DESC
     LIMIT 50`,
    { hospitalId }
  );
  return rows;
}

// Notifications sitting unacknowledged past the escalation threshold and
// not yet flagged -- used by the sockets escalation sweep (see
// sockets/index.js) so a dispatcher can phone the hospital directly
// rather than assuming the portal alert was seen.
async function findPendingEscalations(thresholdSeconds) {
  const [rows] = await pool.query(
    `SELECT id, incident_id, hospital_id FROM hospital_notifications
     WHERE acknowledged_at IS NULL AND escalated_at IS NULL
       AND sent_at < DATE_SUB(NOW(), INTERVAL :thresholdSeconds SECOND)`,
    { thresholdSeconds }
  );
  return rows;
}

async function markEscalated(notificationId) {
  await pool.query('UPDATE hospital_notifications SET escalated_at = NOW(3) WHERE id = :notificationId', {
    notificationId,
  });
}

// Recomputed on demand from the assigned ambulance's current GPS position --
// unlike eta_snapshot_seconds (taken once, when transport started), this
// reflects wherever the ambulance actually is right now. Scoped to
// hospitalId so a hospital can only ever query its own notifications.
async function getLiveEta(notificationId, hospitalId) {
  const [[row]] = await pool.query(
    `SELECT i.assigned_ambulance_id
     FROM hospital_notifications hn
     JOIN incidents i ON i.id = hn.incident_id
     WHERE hn.id = :notificationId AND hn.hospital_id = :hospitalId LIMIT 1`,
    { notificationId, hospitalId }
  );
  if (!row) return null;
  if (!row.assigned_ambulance_id) return { etaSeconds: null };

  const [[ambulance]] = await pool.query(
    'SELECT ST_Y(current_location) AS lat, ST_X(current_location) AS lng FROM ambulances WHERE id = :id LIMIT 1',
    { id: row.assigned_ambulance_id }
  );
  if (!ambulance || ambulance.lat === null) return { etaSeconds: null };

  const [[hospital]] = await pool.query(
    'SELECT ST_Y(location) AS lat, ST_X(location) AS lng FROM hospitals WHERE id = :hospitalId LIMIT 1',
    { hospitalId }
  );
  if (!hospital) return { etaSeconds: null };

  try {
    const route = await routingService.getRoute({ lat: ambulance.lat, lng: ambulance.lng }, { lat: hospital.lat, lng: hospital.lng });
    return { etaSeconds: Math.round(route.durationSeconds) };
  } catch (err) {
    if (err instanceof routingService.OsrmUnavailableError) return { etaSeconds: null, unavailable: true };
    throw err;
  }
}

module.exports = {
  sendPreNotification,
  acknowledge,
  listForHospital,
  findPendingEscalations,
  markEscalated,
  getLiveEta,
};
