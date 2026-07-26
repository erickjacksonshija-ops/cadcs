# Audit Log Integrity (`incident_events`)

The `incident_events` table is the system's non-repudiation record (proposal
Sec 5): every dispatch decision, status change, and notification event,
timestamped server-side, attributed to a user (or `NULL` for a
system-generated event like an escalation timer). For this to be legally
credible, the table must actually be append-only, not just conventionally
treated that way.

## Enforcement, two layers

**Convention** (always applies): `src/services/auditService.js` is the only
module that writes to this table, and it only ever executes `INSERT`. No
route or service issues `UPDATE`/`DELETE` against `incident_events`.

**Database-level grant** (applies to the default write path): a dedicated
MySQL user, `cadcs_audit_writer`, with only `INSERT, SELECT` granted on
`incident_events` -- no `UPDATE`/`DELETE`/`DROP`, so a future bug or a
compromised app process physically cannot modify or remove a row through
this path, regardless of what the code tries to do. Set up via
`scripts/harden-audit-log-grants.sh`; `src/config/auditDb.js` gives
`auditService.js` a separate connection pool authenticated as this user.

### Why not just REVOKE from the existing app user?

The first version of this attempted exactly that -- `REVOKE UPDATE, DELETE
ON incident_events FROM <app_user>` -- and it silently didn't work. MySQL's
official Docker image grants the app user `ALL PRIVILEGES ON <db>.*`
(database-level), and a table-level `REVOKE` cannot narrow a
database-level `GRANT` unless the server has `partial_revokes` enabled --
an instance-wide setting, off by default, not something worth flipping on
a shared/managed host for one table's sake. Verified directly against a
disposable MySQL 8 container: the `REVOKE` ran without error but
`UPDATE`/`DELETE` still succeeded afterward.

The approach that actually works, and what's implemented now: a **new**
user, created with only `INSERT, SELECT` on this one table from the start
-- nothing broader to conflict with.

### The one real limitation

`logEvent()` accepts an optional `connection` for call sites where the
audit write must commit atomically with the state change it records (e.g.
`dispatchService`'s compare-and-swap ambulance assignment: the "assigned"
event and the `ambulances`/`incidents` row updates are one transaction).
Those call sites use the **main** pool's connection, not the restricted
one -- a transaction can't span two separate database connections. That
subset of writes still relies on the convention above, not the DB grant.
This is a real, accepted trade-off, not an oversight: the alternative
(dropping atomicity to route every write through the restricted user)
would let dispatch state and its audit record disagree if the process
crashed between two separate writes, which is worse.

## Setup

```bash
# One-time, after migrations, with MySQL root/admin credentials:
DB_AUDIT_PASSWORD='<generate a real secret>' ./scripts/harden-audit-log-grants.sh

# Then set in .env (or the environment) so the app actually uses it:
DB_AUDIT_USER=cadcs_audit_writer
DB_AUDIT_PASSWORD=<the same secret>
```

If `DB_AUDIT_USER`/`DB_AUDIT_PASSWORD` are unset, `auditDb.js` falls back
to the main app pool -- everything still works, just without the DB-level
enforcement. This is deliberate: an environment that hasn't run the
hardening script yet (all local dev, all of CI) shouldn't be blocked by
it, and shouldn't pay for a second connection pool it isn't using either.
