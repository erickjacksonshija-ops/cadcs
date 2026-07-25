// Direct evidence for proposal Specific Objective v ("to test and evaluate
// system performance through simulated emergency scenarios") and the three
// scenarios required by §3.7:
//   A. Straightforward nearest-ambulance dispatch.
//   B. Nearest ambulance unavailable -> second-nearest is selected instead.
//   C. Two simultaneous incidents, each dispatched correctly and
//      independently.
//
// These exercise the real HTTP API, the real dispatch service, and a real
// self-hosted OSRM instance (Mbeya-region extract) -- nothing here is
// mocked. Each scenario logs the actual measured evidence (ranking order,
// ETAs, timestamps) to the console so a test run doubles as the report
// artifact: `npx jest --runInBand test/scenarios` and copy the console
// output into the results section of the report.
require('../helpers/loadTestEnv');
const request = require('supertest');
const resetDb = require('../helpers/resetDb');
const pool = require('../../src/config/db');
const sessionStore = require('../../src/config/sessionStore');
const createApp = require('../../src/app');
const userService = require('../../src/services/userService');
const { ROLES } = require('../../src/config/roles');

const app = createApp();

// Real Mbeya-area coordinates, spaced far enough apart that ranking is
// unambiguous regardless of minor road-network quirks.
const INCIDENT_A = { lat: -8.9094, lng: 33.4607 }; // Mbeya city centre
const INCIDENT_C = { lat: -8.9302, lng: 33.4515 }; // ~2.5km south, for scenario C's second incident
const NEAR_SITE = { lat: -8.912, lng: 33.463 }; // ~350m from INCIDENT_A
const MID_SITE = { lat: -8.9006, lng: 33.4712 }; // ~1.5km from INCIDENT_A
const FAR_SITE = { lat: -9.05, lng: 33.6 }; // ~20km from INCIDENT_A

async function setupProviderAndDispatcher(label) {
  const [providerResult] = await pool.query(
    'INSERT INTO providers (name, type) VALUES (:name, :type)',
    { name: `${label} Provider`, type: 'private' }
  );
  const providerId = providerResult.insertId;
  const email = `${label.toLowerCase().replace(/\s+/g, '.')}@test.local`;
  await userService.createUser({
    name: `${label} Dispatcher`,
    email,
    password: 'password-123',
    role: ROLES.DISPATCHER,
    providerId,
  });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email, password: 'password-123' });
  return { agent, providerId };
}

async function createAmbulanceAt(providerId, callSign, capability, { lat, lng }, status = 'available') {
  const [result] = await pool.query(
    `INSERT INTO ambulances (provider_id, call_sign, capability_level, status, current_location, last_ping_at)
     VALUES (:providerId, :callSign, :capability, :status, ST_SRID(POINT(:lat, :lng), 4326), NOW())`,
    { providerId, callSign, capability, status, lat, lng }
  );
  return result.insertId;
}

async function createIncidentAt(agent, location, chiefComplaint = 'trauma') {
  const res = await agent.post('/api/incidents').send({
    lat: location.lat,
    lng: location.lng,
    chiefComplaint,
  });
  return res.body.incident.id;
}

describe('Proposal §3.7 scenarios -- evidence for Specific Objective v', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  it('Scenario A: straightforward nearest-ambulance dispatch', async () => {
    const { agent, providerId } = await setupProviderAndDispatcher('Scenario A');
    const nearId = await createAmbulanceAt(providerId, 'A-NEAR', 'BLS', NEAR_SITE);
    const farId = await createAmbulanceAt(providerId, 'A-FAR', 'BLS', FAR_SITE);
    const incidentId = await createIncidentAt(agent, INCIDENT_A);

    const candidatesRes = await agent.get(`/api/incidents/${incidentId}/candidates`);
    expect(candidatesRes.status).toBe(200);
    expect(candidatesRes.body.routingSource).toBe('osrm');
    expect(candidatesRes.body.candidates.map((c) => c.ambulanceId)).toEqual([nearId, farId]);

    const nearest = candidatesRes.body.candidates[0];
    const assignRes = await agent.post(`/api/incidents/${incidentId}/assign`).send({ ambulanceId: nearest.ambulanceId });
    expect(assignRes.status).toBe(200);
    expect(assignRes.body.incident.assigned_ambulance_id).toBe(nearId);

    console.log('\n[Scenario A -- nearest dispatch]');
    console.log(`  Incident at (${INCIDENT_A.lat}, ${INCIDENT_A.lng})`);
    console.log(`  Candidates ranked (nearest first): ${candidatesRes.body.candidates.map((c) => `${c.callSign} (${c.etaSeconds}s ETA)`).join(', ')}`);
    console.log(`  Assigned: ambulance #${nearId} (A-NEAR) -- correct, closest by real road ETA`);
    console.log(`  Result: PASS`);
  });

  it('Scenario B: nearest ambulance unavailable -> second-nearest is selected', async () => {
    const { agent, providerId } = await setupProviderAndDispatcher('Scenario B');
    // The nearest unit exists but is already on another job -- it must be
    // excluded from ranking, not just deprioritized.
    const nearButBusyId = await createAmbulanceAt(providerId, 'B-NEAR-BUSY', 'BLS', NEAR_SITE, 'dispatched');
    const secondNearestId = await createAmbulanceAt(providerId, 'B-SECOND', 'BLS', MID_SITE, 'available');
    const farId = await createAmbulanceAt(providerId, 'B-FAR', 'BLS', FAR_SITE, 'available');
    const incidentId = await createIncidentAt(agent, INCIDENT_A);

    const candidatesRes = await agent.get(`/api/incidents/${incidentId}/candidates`);
    expect(candidatesRes.status).toBe(200);
    const candidateIds = candidatesRes.body.candidates.map((c) => c.ambulanceId);
    expect(candidateIds).not.toContain(nearButBusyId); // excluded -- not available
    expect(candidateIds[0]).toBe(secondNearestId); // top-ranked candidate is the second-nearest overall
    expect(candidateIds).toContain(farId);

    const assignRes = await agent.post(`/api/incidents/${incidentId}/assign`).send({ ambulanceId: candidateIds[0] });
    expect(assignRes.status).toBe(200);
    expect(assignRes.body.incident.assigned_ambulance_id).toBe(secondNearestId);

    console.log('\n[Scenario B -- nearest-unavailable fallback]');
    console.log(`  Nearest unit B-NEAR-BUSY (#${nearButBusyId}) is 'dispatched' -- correctly excluded from candidates`);
    console.log(`  Candidates ranked (nearest first): ${candidatesRes.body.candidates.map((c) => `${c.callSign} (${c.etaSeconds}s ETA)`).join(', ')}`);
    console.log(`  Assigned: ambulance #${secondNearestId} (B-SECOND) -- correct fallback to next-nearest available unit`);
    console.log(`  Result: PASS`);
  });

  it('Scenario C: two simultaneous incidents, each dispatched correctly and independently', async () => {
    const { agent, providerId } = await setupProviderAndDispatcher('Scenario C');
    const ambulanceForA = await createAmbulanceAt(providerId, 'C-UNIT-1', 'BLS', NEAR_SITE);
    const ambulanceForC = await createAmbulanceAt(providerId, 'C-UNIT-2', 'BLS', INCIDENT_C);

    // Two different calls come in at the same time, for two different
    // locations -- created concurrently, not sequentially.
    const [incidentAId, incidentCId] = await Promise.all([
      createIncidentAt(agent, INCIDENT_A, 'trauma'),
      createIncidentAt(agent, INCIDENT_C, 'trauma'),
    ]);
    expect(incidentAId).not.toBe(incidentCId);

    const [candidatesForA, candidatesForC] = await Promise.all([
      agent.get(`/api/incidents/${incidentAId}/candidates`),
      agent.get(`/api/incidents/${incidentCId}/candidates`),
    ]);

    // Each incident independently ranks the unit actually nearest to it,
    // not a shared/stale ranking.
    expect(candidatesForA.body.candidates[0].ambulanceId).toBe(ambulanceForA);
    expect(candidatesForC.body.candidates[0].ambulanceId).toBe(ambulanceForC);

    // Both dispatchers' assignments land concurrently -- neither request
    // interferes with or corrupts the other's incident/ambulance state.
    const [assignA, assignC] = await Promise.all([
      agent.post(`/api/incidents/${incidentAId}/assign`).send({ ambulanceId: ambulanceForA }),
      agent.post(`/api/incidents/${incidentCId}/assign`).send({ ambulanceId: ambulanceForC }),
    ]);
    expect(assignA.status).toBe(200);
    expect(assignC.status).toBe(200);
    expect(assignA.body.incident.assigned_ambulance_id).toBe(ambulanceForA);
    expect(assignC.body.incident.assigned_ambulance_id).toBe(ambulanceForC);

    const [[rowA], [rowC]] = await Promise.all([
      pool.query('SELECT status FROM ambulances WHERE id = ?', [ambulanceForA]),
      pool.query('SELECT status FROM ambulances WHERE id = ?', [ambulanceForC]),
    ]);
    expect(rowA[0].status).toBe('dispatched');
    expect(rowC[0].status).toBe('dispatched');

    console.log('\n[Scenario C -- concurrent incidents]');
    console.log(`  Incident A (#${incidentAId}) at (${INCIDENT_A.lat}, ${INCIDENT_A.lng}) -> assigned C-UNIT-1 (#${ambulanceForA})`);
    console.log(`  Incident C (#${incidentCId}) at (${INCIDENT_C.lat}, ${INCIDENT_C.lng}) -> assigned C-UNIT-2 (#${ambulanceForC})`);
    console.log('  Both incidents created and assigned via concurrent (Promise.all) requests -- no cross-contamination');
    console.log('  Result: PASS');
  });
});
