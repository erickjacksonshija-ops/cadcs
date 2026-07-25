const pool = require('../config/db');

const EVENT_TYPES = [
  'created', 'triage_suggested', 'priority_overridden', 'candidates_ranked',
  'assigned', 'assignment_rejected_conflict', 'dispatched', 'status_changed',
  'hospital_notified', 'hospital_ack_escalated', 'hospital_acknowledged',
  'cancelled', 'closed',
];

// Append-only by convention: this module must be the ONLY place in the
// codebase that writes to incident_events, and it must only ever INSERT
// (see 006_create_incident_events.sql and docs/audit-log-integrity.md for
// the full non-repudiation rationale, plus the Sprint 6 hardening item to
// enforce this with a DB-level INSERT-only grant, not just convention).
//
// occurred_at is deliberately never passed in -- it always comes from the
// column's own DEFAULT CURRENT_TIMESTAMP(3), so the timestamp is always
// server-generated, never trusted from caller input.
async function logEvent(incidentId, eventType, { actorUserId = null, metadata = null, connection } = {}) {
  if (!EVENT_TYPES.includes(eventType)) {
    throw new Error(`Invalid incident event type: ${eventType}`);
  }
  const runner = connection || pool;
  await runner.query(
    `INSERT INTO incident_events (incident_id, event_type, actor_user_id, metadata)
     VALUES (:incidentId, :eventType, :actorUserId, :metadata)`,
    {
      incidentId,
      eventType,
      actorUserId,
      metadata: metadata === null ? null : JSON.stringify(metadata),
    }
  );
}

async function getTimeline(incidentId) {
  const [rows] = await pool.query(
    `SELECT id, event_type, actor_user_id, occurred_at, metadata
     FROM incident_events WHERE incident_id = :incidentId ORDER BY occurred_at ASC, id ASC`,
    { incidentId }
  );
  return rows;
}

module.exports = { logEvent, getTimeline, EVENT_TYPES };
