#!/usr/bin/env bash
# Enforces the append-only guarantee on incident_events at the database
# level (see docs/audit-log-integrity.md). Convention alone -- "only
# auditService.js writes here, and only via INSERT" -- doesn't survive a
# future bug or a compromised app process.
#
# Note on approach: an earlier version of this script tried to REVOKE
# UPDATE/DELETE/DROP on just this one table from the app's EXISTING DB
# user. That doesn't work -- MySQL's official image grants that user
# `ALL PRIVILEGES ON <db>.*` (database-level), and a table-level REVOKE
# cannot narrow a database-level GRANT unless the server has
# `partial_revokes` enabled (an instance-wide setting, off by default, not
# something this script should be flipping on a shared/managed host).
# Verified directly: without it, the REVOKE runs without error but has no
# actual effect -- UPDATE/DELETE still succeed. Confirmed by testing
# against a disposable MySQL 8 container before landing this.
#
# The approach that actually works: a brand-new, separate DB user created
# with ONLY INSERT, SELECT granted on this one table from the start --
# nothing broader to conflict with. src/config/auditDb.js uses this user
# for all non-transactional incident_events writes.
#
# Run once against a fresh database (after migrations). Requires MySQL
# root/admin credentials -- the app's own DB user does not have CREATE
# USER / GRANT privileges, by design.
#
# Usage:
#   ./scripts/harden-audit-log-grants.sh
#   MYSQL_CMD="docker compose exec -T mysql mysql" ./scripts/harden-audit-log-grants.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_ROOT/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found -- cannot read DB credentials." >&2
  exit 1
fi

DB_HOST="${DB_HOST:-$(grep -E '^DB_HOST=' "$ENV_FILE" | cut -d '=' -f2-)}"
DB_PORT="${DB_PORT:-$(grep -E '^DB_PORT=' "$ENV_FILE" | cut -d '=' -f2-)}"
DB_NAME="${DB_NAME:-$(grep -E '^DB_NAME=' "$ENV_FILE" | cut -d '=' -f2-)}"

# The new restricted user's own host part -- '%' for Docker Compose (the
# app connects from a different container), 'localhost' for a native
# install where DB_HOST=localhost. Must match how the app will actually
# connect, or auditDb.js's pool will fail to authenticate.
DB_AUDIT_USER_HOST="${DB_AUDIT_USER_HOST:-%}"
DB_AUDIT_USER="${DB_AUDIT_USER:-$(grep -E '^DB_AUDIT_USER=' "$ENV_FILE" | cut -d '=' -f2-)}"
DB_AUDIT_USER="${DB_AUDIT_USER:-cadcs_audit_writer}"
DB_AUDIT_PASSWORD="${DB_AUDIT_PASSWORD:-$(grep -E '^DB_AUDIT_PASSWORD=' "$ENV_FILE" | cut -d '=' -f2-)}"
if [ -z "$DB_AUDIT_PASSWORD" ]; then
  echo "Error: DB_AUDIT_PASSWORD must be set (env var or in .env) -- refusing to create a user with a guessed/empty password." >&2
  exit 1
fi

# Root/admin credentials, separate from both the app user and the new
# restricted user above.
DB_ROOT_USER="${DB_ROOT_USER:-$(grep -E '^DB_ROOT_USER=' "$ENV_FILE" | cut -d '=' -f2-)}"
DB_ROOT_USER="${DB_ROOT_USER:-root}"
DB_ROOT_PASSWORD="${DB_ROOT_PASSWORD:-$(grep -E '^DB_ROOT_PASSWORD=' "$ENV_FILE" | cut -d '=' -f2-)}"
if [ -z "$DB_ROOT_PASSWORD" ]; then
  DB_ROOT_PASSWORD="$(grep -E '^DB_PASSWORD=' "$ENV_FILE" | cut -d '=' -f2-)"
fi

MYSQL_CMD="${MYSQL_CMD:-mysql}"

echo "[$(date -u +%FT%TZ)] Creating '${DB_AUDIT_USER}'@'${DB_AUDIT_USER_HOST}' with INSERT, SELECT only on ${DB_NAME}.incident_events..."

# shellcheck disable=SC2086
$MYSQL_CMD --host="$DB_HOST" --port="$DB_PORT" --user="$DB_ROOT_USER" --password="$DB_ROOT_PASSWORD" <<SQL
CREATE USER IF NOT EXISTS '${DB_AUDIT_USER}'@'${DB_AUDIT_USER_HOST}' IDENTIFIED BY '${DB_AUDIT_PASSWORD}';
ALTER USER '${DB_AUDIT_USER}'@'${DB_AUDIT_USER_HOST}' IDENTIFIED BY '${DB_AUDIT_PASSWORD}';
GRANT INSERT, SELECT ON \`${DB_NAME}\`.incident_events TO '${DB_AUDIT_USER}'@'${DB_AUDIT_USER_HOST}';
FLUSH PRIVILEGES;
SQL

echo "[$(date -u +%FT%TZ)] Done. Set these in .env (or the environment) so the app actually uses this user for audit writes:"
echo "  DB_AUDIT_USER=${DB_AUDIT_USER}"
echo "  DB_AUDIT_PASSWORD=<the password you set DB_AUDIT_PASSWORD to>"
echo "Verify with: SHOW GRANTS FOR '${DB_AUDIT_USER}'@'${DB_AUDIT_USER_HOST}';"
