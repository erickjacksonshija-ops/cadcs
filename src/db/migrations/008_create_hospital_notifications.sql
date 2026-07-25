CREATE TABLE hospital_notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  incident_id INT NOT NULL,
  hospital_id INT NOT NULL,
  sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  eta_snapshot_seconds INT NULL,
  acknowledged_at TIMESTAMP NULL,
  acknowledged_by INT NULL,
  -- Set when the ack-pending escalation threshold (default 90s, see
  -- HOSPITAL_ACK_ESCALATION_SECONDS) fires without an acknowledgment, so
  -- the dispatcher dashboard can flag it and a human calls the hospital
  -- directly rather than assuming the portal alert was seen.
  escalated_at TIMESTAMP NULL,
  CONSTRAINT fk_notifications_incident FOREIGN KEY (incident_id) REFERENCES incidents(id),
  CONSTRAINT fk_notifications_hospital FOREIGN KEY (hospital_id) REFERENCES hospitals(id),
  CONSTRAINT fk_notifications_ack_by FOREIGN KEY (acknowledged_by) REFERENCES users(id),
  INDEX idx_notifications_incident (incident_id),
  INDEX idx_notifications_hospital_ack (hospital_id, acknowledged_at)
) ENGINE=InnoDB;
