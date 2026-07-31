-- Lightweight crew<->dispatcher coordination channel, scoped to a single
-- mission (incident + the ambulance currently assigned to it). Persisted
-- (not just relayed over the socket) so a message history survives page
-- reloads/reconnects and sits alongside the rest of the incident's record --
-- matches the audit-trail-first design already used for incident_events.
CREATE TABLE mission_messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  incident_id INT NOT NULL,
  ambulance_id INT NOT NULL,
  sender_user_id INT NOT NULL,
  sender_role ENUM('dispatcher', 'crew', 'admin') NOT NULL,
  body VARCHAR(500) NOT NULL,
  sent_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_mission_messages_incident FOREIGN KEY (incident_id) REFERENCES incidents(id),
  CONSTRAINT fk_mission_messages_ambulance FOREIGN KEY (ambulance_id) REFERENCES ambulances(id),
  CONSTRAINT fk_mission_messages_sender FOREIGN KEY (sender_user_id) REFERENCES users(id),
  INDEX idx_mission_messages_incident (incident_id, sent_at)
) ENGINE=InnoDB;
