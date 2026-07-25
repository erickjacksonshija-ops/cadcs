# CADCS — Centralized Ambulance Dispatch & Command System

A real-time, multi-provider ambulance dispatch platform for Mbeya, Tanzania.
Built as a BCS Final Year Project (Mbeya University of Science and
Technology). Coordinates dispatchers, ambulance crews, and receiving
hospitals across multiple providers (government, private, NGO) on one
live system, with real road-network routing rather than straight-line
estimates.

## What it does

- **Dispatcher dashboard** — live map of every registered ambulance
  (regardless of owner), click-to-pin incident intake, a structured
  triage checklist that suggests priority (P1/P2/P3) and required
  capability (BLS/ALS), and a ranked list of candidate ambulances by real
  OSRM road-network ETA — the dispatcher confirms, the algorithm never
  assigns unilaterally.
- **Crew PWA** — installable, mobile-first interface. Receives dispatch
  assignments in real time, reports GPS position during an active
  mission, shows a live turn-by-turn route to the incident, and walks
  through the mission via explicit status buttons
  (`dispatched → en_route → on_scene → transporting → at_hospital → closed`)
  — never inferred from GPS, since device accuracy isn't reliable enough
  to drive state.
- **Hospital portal** — automatic pre-notification the moment a crew
  starts transport, with patient details and a real ETA, an
  acknowledgment flow, and an escalation timer if nobody acknowledges in
  time.
- **Admin panel** — provider/ambulance/hospital/user management,
  admin-mediated password resets, and an analytics dashboard evaluating
  response times against the WHO 8-minute benchmark.

See `docs/` for deeper detail on specific subsystems (security posture,
backup/restore, audit-log integrity, and the scenario evidence used to
evaluate performance against the proposal's required test scenarios).

## Stack

Node.js / Express (MVC), MySQL 8 (spatial types — `POINT`,
`ST_Distance_Sphere`), Socket.IO (session-authenticated, server-assigned
rooms), self-hosted OSRM for real road-network routing, vanilla
JS/HTML/CSS on the frontend (no framework, no build step — four
role-specific single-purpose apps under `public/`).

## Running it

### Prerequisites

- Node.js 18+
- MySQL 8
- A self-hosted OSRM instance with a Mbeya-region OSM extract (or run the
  whole stack via Docker Compose, which includes this)

### Native (development)

```
cp .env.example .env   # fill in real DB credentials and a session secret
npm install
npm run migrate
npm run seed            # creates the admin account (prints its password once)
npm run seed:demo       # optional: realistic demo data (providers, ambulances, one verified hospital, sample incidents)
npm start                # or: npm run dev (nodemon)
```

The app expects a reachable OSRM instance at `OSRM_BASE_URL` (default
`http://localhost:5000`) for real routing; without one, dispatch ranking
and crew route views fall back to straight-line distance with a visible
warning rather than failing.

### Docker Compose (app + MySQL + OSRM together)

```
docker-compose up -d mysql osrm
npm run migrate    # first time only, against the containerized DB (see docker-compose.yml for the host-mapped port)
docker-compose up -d --build app
```

Verified end-to-end: the app container reaches MySQL and OSRM by their
Docker Compose service names (`mysql`, `osrm`) over the internal network,
not the host-mapped ports used for native development.

### Tests

```
npm test                # everything
npm run test:unit
npm run test:integration
npm run test:scenarios  # the three scenarios required by the proposal (§3.7) -- see docs/scenario-evidence.md
```

Integration and scenario tests hit a real MySQL test database
(`.env.test`) and a real OSRM instance — nothing is mocked.

## Demo accounts (after `npm run seed:demo`)

All demo accounts use the password `DemoPass123!`. Admin's password is
whatever `npm run seed` printed (or `ADMIN_SEED_PASSWORD` if set) unless
reset via the admin panel.

| Role | Email | Notes |
|---|---|---|
| Admin | `admin@cadcs.local` | Full CRUD, analytics, password resets |
| Dispatcher | `grace.dispatcher@cadcs.local` | |
| Crew | `sam.crew@cadcs.local` (MB-01, ALS) | Six crew accounts total, one per seeded ambulance |
| Hospital staff | `amina.hospital@cadcs.local` | Mbeya Zonal Referral Hospital |

Only one browser session is active per browser profile at a time
(standard cookie behavior) — use separate browser profiles/Incognito
windows to test multiple roles concurrently, e.g. to watch a dispatcher's
assignment reach a crew member live.

## Project status

Functional and tested (80 passing tests across unit, integration, and
scenario suites). Not yet deployed anywhere beyond local/Docker — actual
hosting is a deliberate, separate decision (see `docs/security.md`'s
note on HTTPS termination being a hard deployment prerequisite, not
optional). Nominatim (address search) is stubbed but not wired up;
click-to-pin covers incident location capture without it.
