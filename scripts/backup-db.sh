#!/usr/bin/env bash
# Scheduled database backup (see plan: "Data Durability" -- a system
# holding legally-relevant incident/audit data needs a real backup story,
# not an assumption it never needs one).
#
# Usage: run on the deployment host, scheduled via cron, e.g. every 6
# hours:
#   0 */6 * * * /path/to/app/scripts/backup-db.sh >> /var/log/cadcs-backup.log 2>&1
#
# Reads DB connection details from .env (same file the app itself uses),
# so credentials live in exactly one place. Requires the mysqldump client
# on the host running this script -- if MySQL only runs inside Docker
# Compose (no native client installed), set MYSQLDUMP_CMD to run it
# through the container instead:
#   MYSQLDUMP_CMD="docker compose exec -T mysql mysqldump" ./scripts/backup-db.sh
# (A bash array would be the "more correct" way to hold a multi-word
# command, but arrays can't be passed across process boundaries via
# environment variables at all -- this has to be a plain string, relying
# on intentional word-splitting below. That's fine for real deployment
# paths, which don't contain spaces; it just means a path that DOES
# contain a space, e.g. testing against a Windows MySQL install under
# "Program Files", won't work as an override here -- add it to PATH
# instead for that case.)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_ROOT/.env"

if [ ! -f "$ENV_FILE" ] && [ -z "${DB_HOST:-}" ]; then
  echo "Error: $ENV_FILE not found, and no DB_* environment variables set -- cannot read DB credentials." >&2
  exit 1
fi

# Only pull the specific vars this script needs, rather than sourcing the
# whole .env file (which may contain values not safe to eval as shell).
# Pre-set environment variables win over .env -- needed when this runs as
# its own Docker Compose service, where the real DB host on the container
# network ("mysql") differs from whatever DB_HOST a host-side .env has for
# native `npm run dev`.
DB_HOST="${DB_HOST:-$(grep -E '^DB_HOST=' "$ENV_FILE" | cut -d '=' -f2-)}"
DB_PORT="${DB_PORT:-$(grep -E '^DB_PORT=' "$ENV_FILE" | cut -d '=' -f2-)}"
DB_USER="${DB_USER:-$(grep -E '^DB_USER=' "$ENV_FILE" | cut -d '=' -f2-)}"
DB_PASSWORD="${DB_PASSWORD:-$(grep -E '^DB_PASSWORD=' "$ENV_FILE" | cut -d '=' -f2-)}"
DB_NAME="${DB_NAME:-$(grep -E '^DB_NAME=' "$ENV_FILE" | cut -d '=' -f2-)}"

BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"
RETENTION_COUNT="${RETENTION_COUNT:-28}" # ~7 days at 4 backups/day
MYSQLDUMP_CMD="${MYSQLDUMP_CMD:-mysqldump}"

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT_FILE="$BACKUP_DIR/cadcs-${DB_NAME}-${TIMESTAMP}.sql.gz"

echo "[$(date -u +%FT%TZ)] Starting backup of ${DB_NAME} to ${OUT_FILE}"

# Intentionally unquoted -- see the MYSQLDUMP_CMD comment above.
# shellcheck disable=SC2086
$MYSQLDUMP_CMD \
  --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" --password="$DB_PASSWORD" \
  --single-transaction --routines --triggers \
  "$DB_NAME" | gzip > "$OUT_FILE"

echo "[$(date -u +%FT%TZ)] Backup complete: $(du -h "$OUT_FILE" | cut -f1)"

# Prune old backups beyond the retention count -- keeps disk usage bounded
# without needing a separate cleanup job.
BACKUP_COUNT=$(ls -1 "$BACKUP_DIR"/cadcs-"${DB_NAME}"-*.sql.gz 2>/dev/null | wc -l)
if [ "$BACKUP_COUNT" -gt "$RETENTION_COUNT" ]; then
  ls -1t "$BACKUP_DIR"/cadcs-"${DB_NAME}"-*.sql.gz | tail -n +$((RETENTION_COUNT + 1)) | xargs rm -f
  echo "[$(date -u +%FT%TZ)] Pruned old backups, keeping the ${RETENTION_COUNT} most recent."
fi
