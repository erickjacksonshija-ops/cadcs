-- Crew safety/panic button (see plan: "Crew SOS/safety button") needs its
-- own audit event type -- an SOS is itself a safety-critical, non-repudiation
-- event, exactly the kind of thing incident_events exists to record.
ALTER TABLE incident_events
  MODIFY COLUMN event_type ENUM(
    'created', 'triage_suggested', 'priority_overridden', 'candidates_ranked',
    'assigned', 'assignment_rejected_conflict', 'dispatched', 'status_changed',
    'hospital_notified', 'hospital_ack_escalated', 'hospital_acknowledged',
    'cancelled', 'closed', 'sos_triggered'
  ) NOT NULL;
