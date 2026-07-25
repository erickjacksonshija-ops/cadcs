CREATE TABLE ambulances (
  id INT AUTO_INCREMENT PRIMARY KEY,
  provider_id INT NOT NULL,
  call_sign VARCHAR(50) NOT NULL,
  capability_level ENUM('BLS', 'ALS') NOT NULL,
  status ENUM('available', 'dispatched', 'en_route', 'on_scene', 'transporting', 'at_hospital', 'out_of_service')
    NOT NULL DEFAULT 'out_of_service',
  -- Nullable: a newly registered ambulance has no GPS fix until its crew
  -- app sends the first ping. A spatial index requires NOT NULL in InnoDB,
  -- so this column is intentionally left unindexed — full-scan
  -- ST_Distance_Sphere over a single city's fleet (tens of units) is fast
  -- enough at this scale; documented as a future scaling item if the fleet
  -- grows into the thousands.
  current_location POINT NULL SRID 4326,
  last_ping_at TIMESTAMP NULL,
  -- Shift-based assignment: which crew user is currently operating this
  -- unit. Nullable because a unit can be unstaffed between shifts. This is
  -- deliberately simple (single current assignment, no shift-scheduling
  -- module) -- shift planning is out of this project's scope.
  current_crew_user_id INT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ambulances_provider FOREIGN KEY (provider_id) REFERENCES providers(id),
  CONSTRAINT fk_ambulances_crew_user FOREIGN KEY (current_crew_user_id) REFERENCES users(id),
  UNIQUE KEY uq_ambulances_provider_callsign (provider_id, call_sign),
  INDEX idx_ambulances_status (status)
) ENGINE=InnoDB;
