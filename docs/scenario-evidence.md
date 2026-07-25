# Scenario Evidence -- Proposal §3.7 / Specific Objective v

Evidence for Specific Objective v ("to test and evaluate system performance
through simulated emergency scenarios") and the three scenarios required by
§3.7. Source: `test/scenarios/proposalScenarios.test.js`. Run with:

```
npm run test:scenarios
```

These are **not mocked** -- every scenario runs the real HTTP API
(`supertest` against the actual Express app), the real dispatch service
(`dispatchService.rankCandidates` / `assignAmbulance`), and a real
self-hosted OSRM instance (Mbeya-region OSM extract) for road-network ETA
computation. `db.query`/`db.assign` calls hit a real MySQL test database,
reset between each scenario.

## Result summary

All three scenarios pass. Run below is a genuine, unedited console capture
(2026-07-25) -- ETAs vary between scenarios because OSRM computes them
from real Mbeya road-network geometry for each specific origin/destination
pair, not a fixed or fabricated number.

## Scenario A -- straightforward nearest-ambulance dispatch

Two ambulances (one ~350m from the incident, one ~20km away) respond to a
single incident. The dispatch algorithm must rank the nearer unit first by
real road ETA, and assignment must go to that unit.

```
Incident at (-8.9094, 33.4607)
Candidates ranked (nearest first): A-NEAR (94s ETA), A-FAR (1597.5s ETA)
Assigned: ambulance #1 (A-NEAR) -- correct, closest by real road ETA
Result: PASS
```

## Scenario B -- nearest ambulance unavailable, second-nearest selected

The nearest unit to the incident exists but is already committed to
another job (`status = 'dispatched'`). The algorithm must exclude it
entirely from ranking (not merely deprioritize it) and correctly promote
the next-nearest *available* unit to the top of the candidate list.

```
Nearest unit B-NEAR-BUSY (#1) is 'dispatched' -- correctly excluded from candidates
Candidates ranked (nearest first): B-SECOND (284.7s ETA), B-FAR (1597.5s ETA)
Assigned: ambulance #2 (B-SECOND) -- correct fallback to next-nearest available unit
Result: PASS
```

## Scenario C -- two simultaneous incidents

Two incidents at different real Mbeya locations are created and dispatched
*concurrently* (`Promise.all`, not sequential requests) against two
different available ambulances. Each incident must independently rank and
receive the unit actually nearest to it, and both assignments must succeed
without corrupting or interfering with each other's state.

```
Incident A (#1) at (-8.9094, 33.4607) -> assigned C-UNIT-1 (#1)
Incident C (#2) at (-8.9302, 33.4515) -> assigned C-UNIT-2 (#2)
Both incidents created and assigned via concurrent (Promise.all) requests -- no cross-contamination
Result: PASS
```

## Relationship to the broader test suite

These three scenarios are the specific ones §3.7 names, presented as a
standalone, labeled artifact for the report. They are not the only
dispatch-correctness evidence in the codebase -- `test/integration/dispatch.test.js`
additionally covers capability-level matching (BLS/ALS), atomic
compare-and-swap assignment (no double-booking), audit-trail recording,
and RBAC enforcement, and `test/integration/analytics.test.js` covers the
WHO 8-minute response-time benchmark evaluation referenced elsewhere in
the proposal (§1.1).
