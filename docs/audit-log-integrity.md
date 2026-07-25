# Audit Log Integrity (`incident_events`)

The `incident_events` table is the system's non-repudiation record (proposal
Sec 5): every dispatch decision, status change, and notification event,
timestamped server-side, attributed to a user (or `NULL` for a
system-generated event like an escalation timer). For this to be legally
credible, the table must actually be append-only, not just conventionally
treated that way.

## Current state (Sprint 1-5)

Enforced by convention: `src/services/auditService.js` is the only module
that writes to this table, and it only ever executes `INSERT`. No route or
service issues `UPDATE`/`DELETE` against `incident_events`.

## Sprint 6 hardening (planned, not yet applied)

Convention isn't enough for a production claim -- a future bug or a
compromised app process could still issue an `UPDATE`/`DELETE`. The real
fix is a database-level guarantee: a dedicated MySQL user for the
application's audit-writing path with only `INSERT, SELECT` privileges on
`incident_events` (no `UPDATE`/`DELETE`/`DROP`), separate from the general
app user's full CRUD grant on the other tables.

```sql
CREATE USER 'cadcs_audit_writer'@'localhost' IDENTIFIED BY '<generate a real secret>';
GRANT INSERT, SELECT ON cadcs_dispatch.incident_events TO 'cadcs_audit_writer'@'localhost';
```

Wiring this in means `auditService.js` uses a second connection pool
(scoped to this restricted user) instead of the shared app pool -- deferred
to Sprint 6 rather than done now, to avoid a half-built two-pool
architecture in the middle of foundational scaffolding. Tracked here so it
isn't forgotten.
