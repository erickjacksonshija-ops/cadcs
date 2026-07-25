#!/usr/bin/env bash
# Runs once when the Codespace is created. Brings up the full stack
# (app + MySQL + OSRM, real Mbeya routing data already committed in
# osrm-data/) with no manual steps -- open the forwarded port 3000 and
# the app is ready.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  SESSION_SECRET=$(openssl rand -hex 32)
  DB_PASSWORD=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24)
  sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=${SESSION_SECRET}/" .env
  sed -i "s/^DB_PASSWORD=.*/DB_PASSWORD=${DB_PASSWORD}/" .env
  # Codespaces' forwarded-port URLs are real HTTPS (terminated by GitHub's
  # proxy), so secure session cookies work correctly here.
  sed -i "s/^NODE_ENV=.*/NODE_ENV=production/" .env
fi

docker compose up -d mysql osrm

echo "Waiting for MySQL to become healthy..."
for i in $(seq 1 30); do
  status=$(docker inspect --format='{{.State.Health.Status}}' "$(docker compose ps -q mysql)" 2>/dev/null || echo "starting")
  if [ "$status" = "healthy" ]; then
    break
  fi
  sleep 3
done

docker compose build app
docker compose run --rm app node src/db/migrate.js
docker compose run --rm app node src/db/seedDemo.js

docker compose up -d app

echo ""
echo "CADCS is up. Open the 'Ports' tab, set port 3000 to Public if it isn't already, and open it."
echo "Demo accounts (password: DemoPass123!):"
echo "  Dispatcher:      grace.dispatcher@cadcs.local"
echo "  Crew (MB-01):    sam.crew@cadcs.local"
echo "  Hospital staff:  amina.hospital@cadcs.local"
