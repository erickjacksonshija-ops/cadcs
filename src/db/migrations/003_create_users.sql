CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  phone VARCHAR(30),
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('dispatcher', 'crew', 'hospital_staff', 'admin') NOT NULL,
  -- dispatcher/crew belong to an ambulance provider; hospital_staff belongs
  -- to a hospital; admin belongs to neither. Enforced by CHECK below so the
  -- constraint lives in the database, not just in application code.
  provider_id INT NULL,
  hospital_id INT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_provider FOREIGN KEY (provider_id) REFERENCES providers(id),
  CONSTRAINT fk_users_hospital FOREIGN KEY (hospital_id) REFERENCES hospitals(id),
  CONSTRAINT chk_users_role_links CHECK (
    (role IN ('dispatcher', 'crew') AND provider_id IS NOT NULL AND hospital_id IS NULL)
    OR (role = 'hospital_staff' AND hospital_id IS NOT NULL AND provider_id IS NULL)
    OR (role = 'admin' AND provider_id IS NULL AND hospital_id IS NULL)
  )
) ENGINE=InnoDB;
