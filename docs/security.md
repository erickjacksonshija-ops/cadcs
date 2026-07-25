# Security Posture

A record of what's actually implemented and verified, and what a deployer
still has to do -- not a claim of a formal audit.

## Transport

The app itself does not terminate TLS. `cookie.secure` is tied to
`NODE_ENV=production` (`src/app.js`), which means: **running with
`NODE_ENV=production` behind anything other than an HTTPS-terminating
reverse proxy (nginx, Caddy, the platform's own load balancer) will break
login** -- the browser silently drops a `secure` cookie sent over plain
HTTP. This is deliberate (never send session cookies over an unencrypted
connection in production) but it means HTTPS termination is a **hard
deployment prerequisite**, not an optional hardening step.

## Security headers (`helmet`, `src/app.js`)

- A Content-Security-Policy scoped to what the four frontends actually
  load: `'self'` plus `unpkg.com` for Leaflet, plus OSM's tile subdomains
  for map imagery. No `'unsafe-inline'` on `script-src` -- every frontend
  was audited to confirm no inline `<script>` blocks or inline event
  handler attributes exist (the login page's inline script was moved to
  `public/login/app.js` specifically so this could stay strict).
  `style-src` does allow `'unsafe-inline'`, since inline `style=""`
  attributes and `.style` property assignments are used throughout the
  vanilla-JS rendering -- CSS injection isn't a comparable risk to script
  injection, and there's no practical nonce/hash scheme for dynamically
  generated `innerHTML` templates.
- `crossOriginEmbedderPolicy` is explicitly disabled -- OSM's tile
  servers don't send `Cross-Origin-Resource-Policy` headers, and helmet's
  default COEP (`require-corp`) would silently block every map tile.
- `X-Powered-By` removed, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: SAMEORIGIN`, and the rest of helmet's defaults are on.
- **Verified live**, not just configured: logged in through the actual
  browser with the CSP active, confirmed zero CSP console violations, and
  confirmed the dispatcher map still renders tiles and markers.

## Stored XSS

Every one of the four frontends (`dispatcher`, `admin`, `crew`,
`hospital`) renders via `innerHTML` template literals (a deliberate
no-framework, no-build-step choice). Any free-text field one authenticated
role can enter and another can view -- `chief_complaint`,
`location_description`, `patient_notes`, `cancel_reason`,
provider/hospital/user `name`, server `err.message` strings, and analytics
labels derived from provider names -- is wrapped in the shared
`escapeHtml()` (`public/shared/api.js`) before interpolation. This was
found and fixed as a genuine cross-role risk (a compromised or malicious
account's free text could otherwise execute in another user's session,
e.g. a dispatcher's browser rendering a crew-submitted field), not a
theoretical one.

## CSRF

No separate CSRF token scheme. Relying on `cookie.sameSite: 'lax'`
(`src/app.js`) plus the fact that every state-changing endpoint is a
JSON-body `POST`/etc: `SameSite=Lax` cookies are withheld on cross-site
`POST` requests (only sent on top-level `GET` navigation), so a
cross-origin form or script cannot ride the session cookie into a mutating
endpoint. This is sufficient for the app's actual request shape; it would
not be sufficient if a state-changing `GET` endpoint were ever added.

## Rate limiting

`express-rate-limit` on `POST /api/auth/login` only (10 attempts / 15 min
per IP in production, configurable via `LOGIN_RATE_LIMIT_MAX`) --
brute-force protection on the one truly public, unauthenticated endpoint.
Every other mutating endpoint requires an authenticated session first, so
the relevant control there is account provisioning being admin-only (no
public self-registration), not per-route rate limiting.

## Session cookies

`httpOnly: true` (no client-script access), `sameSite: 'lax'`,
`secure: NODE_ENV === 'production'`, 12-hour `maxAge`, backed by
`express-mysql-session` (survives restarts, not the leaking in-memory
default store).

## SQL injection

All queries go through `mysql2`'s parameterized query API
(`pool.query(sql, params)`) across every service file -- no string-built
SQL anywhere in the codebase.

## Account provisioning

No public self-registration endpoint exists. Only an authenticated
`admin` can create dispatcher/crew/hospital-staff/admin accounts
(`POST /api/admin/users`), and only an admin can reset another user's
password (`POST /api/admin/users/:id/reset-password`) -- there is
deliberately no self-service "forgot password" flow, since a life-safety
dispatch system's accounts are a smaller, known, administratively-managed
set, not a general public user base.

## Known gap, deliberately out of scope for now

Dependency audit shows high-severity advisories, but they're entirely
inside the `eslint`/`jest` devDependency chain (a `minimatch`/
`brace-expansion` DoS advisory) -- confirmed via
`npm ls --prod --depth=0` that none of it reaches the production
dependency tree. Left unresolved because the available fix
(`npm audit fix --force`) is a breaking `eslint` major-version bump, and
these packages never run in the deployed app.
