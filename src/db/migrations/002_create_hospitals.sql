CREATE TABLE hospitals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  -- NOT NULL by design: a hospital's location is always known at creation
  -- time (unlike an ambulance, which may not have reported a GPS fix yet),
  -- so a spatial index is safe here.
  location POINT NOT NULL SRID 4326,
  address VARCHAR(255),
  contact_phone VARCHAR(30),
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  SPATIAL INDEX idx_hospitals_location (location)
) ENGINE=InnoDB;
