# Database Backups

See the plan's "Data Durability" section for why this exists: a system
holding legally-relevant incident and audit data needs a real backup
story, not an assumption it never needs one.

## Scripts

- `scripts/backup-db.sh` — dumps the database (schema + data, gzip
  compressed) to `backups/`, timestamped, with automatic pruning beyond a
  retention count (default 28).
- `scripts/restore-db.sh` — restores a backup. Requires typing the target
  database name to confirm, since this is destructive.

Both scripts read connection details from `.env` — the same credentials
the app itself uses, so nothing is duplicated.

**Verified**: this backup/restore cycle has been tested end-to-end against
a real database (not just written and assumed) — a real backup was taken,
restored into a separate scratch database, and every table's row count
confirmed to match the original exactly.

## Scheduling (production)

Add to the deployment host's crontab, e.g. every 6 hours:

```
0 */6 * * * /path/to/app/scripts/backup-db.sh >> /var/log/cadcs-backup.log 2>&1
```

If MySQL only runs inside Docker Compose (no native `mysqldump` client on
the host), point the script at the containerized one instead:

```
MYSQLDUMP_CMD="docker compose exec -T mysql mysqldump" ./scripts/backup-db.sh
```

## Restoring

```
./scripts/restore-db.sh backups/cadcs-cadcs_dispatch-20260725T120000Z.sql.gz
```

To verify a backup is restorable without touching real data (e.g. before
trusting it, or to rehearse a disaster-recovery drill), restore into a
separate database first:

```
TARGET_DB_NAME=cadcs_restore_check ./scripts/restore-db.sh backups/<file>.sql.gz
```

## Where backups actually live

`backups/` is local disk on whatever host runs the script and is
`.gitignore`d (it contains real data, including password hashes and
patient information — it must never be committed or otherwise exposed).
For genuine durability, back that directory up to separate storage too
(e.g. sync it to object storage) — local-disk-only backups don't protect
against the host itself failing.
