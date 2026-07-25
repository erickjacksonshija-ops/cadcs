#!/usr/bin/env bash
# Restores a backup created by backup-db.sh. Deliberately requires the
# target database name to be passed explicitly and confirmed -- a restore
# is destructive (overwrites current data), so this should never run
# unattended or by accident.
#
# Usage: ./scripts/restore-db.sh /path/to/backups/cadcs-cadcs_dispatch-20260725T120000Z.sql.gz
# Optional: TARGET_DB_NAME=some_other_db ./scripts/restore-db.sh backup.sql.gz
#   -- restores into a different database than the one in .env, e.g. to
#   verify a backup is actually restorable against a scratch/staging
#   database without touching real data.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_ROOT/.env"

BACKUP_FILE="${1:-}"
if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  echo "Usage: $0 /path/to/backup.sql.gz" >&2
  exit 1
fi

DB_HOST=$(grep -E '^DB_HOST=' "$ENV_FILE" | cut -d '=' -f2-)
DB_PORT=$(grep -E '^DB_PORT=' "$ENV_FILE" | cut -d '=' -f2-)
DB_USER=$(grep -E '^DB_USER=' "$ENV_FILE" | cut -d '=' -f2-)
DB_PASSWORD=$(grep -E '^DB_PASSWORD=' "$ENV_FILE" | cut -d '=' -f2-)
DB_NAME="${TARGET_DB_NAME:-$(grep -E '^DB_NAME=' "$ENV_FILE" | cut -d '=' -f2-)}"
# Plain string, intentionally word-split below -- see backup-db.sh's
# MYSQLDUMP_CMD comment for why this can't be a bash array.
MYSQL_CMD="${MYSQL_CMD:-mysql}"

echo "This will OVERWRITE all data in database '${DB_NAME}' on ${DB_HOST}:${DB_PORT}."
read -r -p "Type the database name to confirm: " CONFIRM
if [ "$CONFIRM" != "$DB_NAME" ]; then
  echo "Confirmation did not match -- aborted, nothing changed."
  exit 1
fi

echo "[$(date -u +%FT%TZ)] Restoring ${BACKUP_FILE} into ${DB_NAME}..."
# shellcheck disable=SC2086
gunzip -c "$BACKUP_FILE" | $MYSQL_CMD --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" --password="$DB_PASSWORD" "$DB_NAME"
echo "[$(date -u +%FT%TZ)] Restore complete."
