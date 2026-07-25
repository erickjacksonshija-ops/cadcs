CREATE TABLE incidents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  caller_phone VARCHAR(30),
  -- Always captured via click-to-pin (or Nominatim search confirmed by a
  -- click) before an incident can be created -- never a bare text address.
  location POINT NOT NULL SRID 4326,
  location_description VARCHAR(255),
  chief_complaint ENUM('trauma', 'cardiac', 'obstetric', 'respiratory', 'other') NOT NULL,
  -- Structured triage red-flag answers (conscious/breathing/severe_bleeding
  -- etc.) captured as answered, so the record shows exactly what the
  -- dispatcher was told, not just the derived tier.
  red_flags JSON NOT NULL,
  suggested_priority ENUM('P1', 'P2', 'P3') NOT NULL,
  suggested_capability ENUM('BLS', 'ALS') NOT NULL,
  -- Dispatcher-confirmed values, which may differ from the suggestion --
  -- both are kept so an override is visible, not silently overwritten.
  priority ENUM('P1', 'P2', 'P3') NOT NULL,
  required_capability ENUM('BLS', 'ALS') NOT NULL,
  patient_notes TEXT,
  status ENUM(
    'reported', 'assigned', 'dispatched', 'en_route',
    'on_scene', 'transporting', 'at_hospital', 'closed', 'cancelled'
  ) NOT NULL DEFAULT 'reported',
  cancel_reason VARCHAR(255) NULL,
  assigned_ambulance_id INT NULL,
  assigned_hospital_id INT NULL,
  created_by INT NOT NULL,
  closed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_incidents_ambulance FOREIGN KEY (assigned_ambulance_id) REFERENCES ambulances(id),
  CONSTRAINT fk_incidents_hospital FOREIGN KEY (assigned_hospital_id) REFERENCES hospitals(id),
  CONSTRAINT fk_incidents_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  SPATIAL INDEX idx_incidents_location (location),
  INDEX idx_incidents_status (status),
  INDEX idx_incidents_reported_at (reported_at)
) ENGINE=InnoDB;
