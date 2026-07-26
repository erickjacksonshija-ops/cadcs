#!/usr/bin/env bash
# Resets the operational/demo data (incidents, their audit trail, GPS
# ping history, hospital notifications, and all logged-in sessions) back
# to a clean slate, then reseeds fresh demo incidents through the real
# service layer. Providers, hospitals, ambulances, and user accounts are
# left untouched (seedDemo.js's findOrCreate* helpers already make
# reseeding them a no-op) -- this only clears the parts that accumulate
# clutter from live testing/demoing.
#
# Run this right before a demo/presentation, not during normal
# development -- it destroys the current incident history.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${DB_HOST:=localhost}"
: "${DB_PORT:=3306}"
: "${DB_USER:?DB_USER must be set (check .env)}"
: "${DB_PASSWORD:?DB_PASSWORD must be set (check .env)}"
: "${DB_NAME:?DB_NAME must be set (check .env)}"

echo "This will permanently delete all incidents, audit events, GPS ping"
echo "history, hospital notifications, and active sessions in '$DB_NAME'."
echo "Providers, hospitals, ambulances, and user accounts are kept."
read -r -p "Type the database name ($DB_NAME) to confirm: " confirm
if [ "$confirm" != "$DB_NAME" ]; then
  echo "Aborted -- confirmation did not match."
  exit 1
fi

MYSQL_CMD=${MYSQL_CMD:-mysql}

MYSQL_PWD="$DB_PASSWORD" $MYSQL_CMD -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" <<SQL
SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE incident_events;
TRUNCATE TABLE ambulance_location_pings;
TRUNCATE TABLE hospital_notifications;
TRUNCATE TABLE incidents;
TRUNCATE TABLE sessions;
SET FOREIGN_KEY_CHECKS = 1;
UPDATE ambulances SET status = 'available';
-- Any hospital that was only deactivated (rather than deleted) because a
-- now-cleared incident referenced it can be safely removed for real.
DELETE FROM hospitals WHERE active = 0;
SQL

echo "Cleared. Reseeding demo dataset..."
node src/db/seedDemo.js
