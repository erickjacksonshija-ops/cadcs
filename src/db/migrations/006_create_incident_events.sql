-- Append-only audit trail. Application code must only ever INSERT into this
-- table (enforced by convention in auditService.js now; a dedicated
-- INSERT-only MySQL grant for the app user is a documented Sprint 6
-- hardening step -- see docs/audit-log-integrity.md). Every dispatch
-- decision, status change, and notification event is recorded here with a
-- server-generated timestamp so the non-repudiation claim in the proposal's
-- ethics section (Sec 5) actually holds.
CREATE TABLE incident_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  incident_id INT NOT NULL,
  event_type ENUM(
    'created', 'triage_suggested', 'priority_overridden', 'candidates_ranked',
    'assigned', 'assignment_rejected_conflict', 'dispatched', 'status_changed',
    'hospital_notified', 'hospital_ack_escalated', 'hospital_acknowledged',
    'cancelled', 'closed'
  ) NOT NULL,
  -- NULL actor = system-generated event (e.g. an escalation timer firing),
  -- not attributable to a logged-in user.
  actor_user_id INT NULL,
  occurred_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  metadata JSON NULL,
  CONSTRAINT fk_events_incident FOREIGN KEY (incident_id) REFERENCES incidents(id),
  CONSTRAINT fk_events_actor FOREIGN KEY (actor_user_id) REFERENCES users(id),
  INDEX idx_events_incident_time (incident_id, occurred_at)
) ENGINE=InnoDB;
