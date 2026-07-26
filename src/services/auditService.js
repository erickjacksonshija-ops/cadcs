const pool = require('../config/db');
const auditWriterPool = require('../config/auditDb');

const EVENT_TYPES = [
  'created', 'triage_suggested', 'priority_overridden', 'candidates_ranked',
  'assigned', 'assignment_rejected_conflict', 'dispatched', 'status_changed',
  'hospital_notified', 'hospital_ack_escalated', 'hospital_acknowledged',
  'cancelled', 'closed',
];

// Append-only, enforced two ways:
//  - This module must be the ONLY place in the codebase that writes to
//    incident_events, and it must only ever INSERT.
//  - When no transaction connection is supplied, the write runs through
//    auditWriterPool, a separate connection pool authenticated as a DB
//    user with only INSERT, SELECT granted on this table (see
//    docs/audit-log-integrity.md and scripts/harden-audit-log-grants.sh) --
//    UPDATE/DELETE from this path fail at the database level, not just by
//    convention.
//  - Call sites that pass `connection` (dispatchService's atomic
//    assignment/status-change transactions, where the audit entry must
//    commit atomically with the state change it records) use the main
//    pool's connection instead, since a transaction can't span two
//    separate connections. Those still rely on the single-writer,
//    INSERT-only convention above -- a real, documented limitation, not
//    an oversight.
//
// occurred_at is deliberately never passed in -- it always comes from the
// column's own DEFAULT CURRENT_TIMESTAMP(3), so the timestamp is always
// server-generated, never trusted from caller input.
async function logEvent(incidentId, eventType, { actorUserId = null, metadata = null, connection } = {}) {
  if (!EVENT_TYPES.includes(eventType)) {
    throw new Error(`Invalid incident event type: ${eventType}`);
  }
  const runner = connection || auditWriterPool;
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
