-- Web Push subscriptions (see src/services/pushService.js and plan:
-- "Notification Reliability" -- fires hospital pre-notifications and
-- dispatcher escalation alerts as OS-level notifications even when the
-- tab is backgrounded or the browser is closed).
--
-- One user can have multiple subscriptions (e.g. a hospital staff member
-- who enabled notifications on both a desktop and a phone browser) --
-- endpoint is the natural unique key the Push API gives each
-- registration, not user_id, so re-subscribing the same browser updates
-- rather than duplicates.
CREATE TABLE push_subscriptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  endpoint VARCHAR(500) NOT NULL,
  p256dh_key VARCHAR(255) NOT NULL,
  auth_key VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_push_subscriptions_user FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE KEY uq_push_subscriptions_endpoint (endpoint(255)),
  INDEX idx_push_subscriptions_user (user_id)
) ENGINE=InnoDB;
