-- Mid-incident priority escalation (see plan: "Mid-incident priority
-- escalation") needs its own audit event type, distinct from
-- 'priority_overridden' (which records a dispatcher overriding the
-- triage *suggestion* at creation time) -- this records a priority change
-- to an incident that's already in progress.
ALTER TABLE incident_events
  MODIFY COLUMN event_type ENUM(
    'created', 'triage_suggested', 'priority_overridden', 'candidates_ranked',
    'assigned', 'assignment_rejected_conflict', 'dispatched', 'status_changed',
    'hospital_notified', 'hospital_ack_escalated', 'hospital_acknowledged',
    'cancelled', 'closed', 'sos_triggered', 'priority_changed'
  ) NOT NULL;
