-- Sampled position history (on status change, plus roughly every 15s during
-- an active mission) rather than every raw GPS tick, to keep this table's
-- growth sane. ambulances.current_location holds the live position; this
-- table is the trail used for post-incident review and route reconstruction.
CREATE TABLE ambulance_location_pings (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ambulance_id INT NOT NULL,
  location POINT NOT NULL SRID 4326,
  recorded_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_pings_ambulance FOREIGN KEY (ambulance_id) REFERENCES ambulances(id),
  INDEX idx_pings_ambulance_time (ambulance_id, recorded_at)
) ENGINE=InnoDB;
