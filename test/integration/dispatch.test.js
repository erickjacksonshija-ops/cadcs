require('../helpers/loadTestEnv');
const request = require('supertest');
const resetDb = require('../helpers/resetDb');
const pool = require('../../src/config/db');
const sessionStore = require('../../src/config/sessionStore');
const createApp = require('../../src/app');
const userService = require('../../src/services/userService');
const { ROLES } = require('../../src/config/roles');

const app = createApp();

// Mbeya-area coordinates, spaced out enough that Haversine ranking is
// unambiguous.
const INCIDENT_LOCATION = { lat: -8.9094, lng: 33.4607 };
const NEAR_AMBULANCE = { lat: -8.912, lng: 33.463 }; // ~350m away
const FAR_AMBULANCE = { lat: -9.05, lng: 33.6 }; // ~20km away

async function setupProviderAndDispatcher() {
  const [providerResult] = await pool.query(
    "INSERT INTO providers (name, type) VALUES ('Test Provider', 'private')"
  );
  const providerId = providerResult.insertId;
  await userService.createUser({
    name: 'Dispatcher',
    email: 'dispatcher@test.local',
    password: 'password-123',
    role: ROLES.DISPATCHER,
    providerId,
  });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email: 'dispatcher@test.local', password: 'password-123' });
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

async function createIncidentAt(agent, chiefComplaint = 'trauma') {
  const res = await agent.post('/api/incidents').send({
    lat: INCIDENT_LOCATION.lat,
    lng: INCIDENT_LOCATION.lng,
    chiefComplaint,
  });
  return res.body.incident.id;
}

describe('dispatch algorithm (integration)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  it('ranks candidates nearest-first using real OSRM road-network ETAs', async () => {
    const { agent, providerId } = await setupProviderAndDispatcher();
    const farId = await createAmbulanceAt(providerId, 'MB-FAR', 'BLS', FAR_AMBULANCE);
    const nearId = await createAmbulanceAt(providerId, 'MB-NEAR', 'BLS', NEAR_AMBULANCE);
    const incidentId = await createIncidentAt(agent);

    const res = await agent.get(`/api/incidents/${incidentId}/candidates`);

    expect(res.status).toBe(200);
    // This test runs against a live, self-hosted OSRM instance (Mbeya
    // region extract) -- confirms the real routing path, not the fallback.
    expect(res.body.routingSource).toBe('osrm');
    expect(res.body.candidates.map((c) => c.ambulanceId)).toEqual([nearId, farId]);
    expect(res.body.candidates[0].etaSeconds).toBeGreaterThan(0);
    expect(res.body.candidates[0].etaSeconds).toBeLessThan(res.body.candidates[1].etaSeconds);
  });

  it('excludes ambulances that are not available, inactive, or have no known location', async () => {
    const { agent, providerId } = await setupProviderAndDispatcher();
    await createAmbulanceAt(providerId, 'MB-BUSY', 'BLS', NEAR_AMBULANCE, 'dispatched');
    const [noLocationResult] = await pool.query(
      `INSERT INTO ambulances (provider_id, call_sign, capability_level, status) VALUES (:providerId, 'MB-NOLOC', 'BLS', 'available')`,
      { providerId }
    );
    const incidentId = await createIncidentAt(agent);

    const res = await agent.get(`/api/incidents/${incidentId}/candidates`);
    expect(res.body.candidates).toHaveLength(0);
    expect(noLocationResult.insertId).toBeTruthy();
  });

  it('excludes a BLS ambulance from an ALS-required incident but includes it for a BLS-required one', async () => {
    const { agent, providerId } = await setupProviderAndDispatcher();
    await createAmbulanceAt(providerId, 'MB-BLS', 'BLS', NEAR_AMBULANCE);
    // 'other' chief complaint with no red flags -> P3/BLS per triageService
    const blsIncidentId = await createIncidentAt(agent, 'other');
    // 'cardiac' -> P2/ALS per triageService
    const alsIncidentId = await createIncidentAt(agent, 'cardiac');

    const blsRes = await agent.get(`/api/incidents/${blsIncidentId}/candidates`);
    expect(blsRes.body.candidates).toHaveLength(1);

    const alsRes = await agent.get(`/api/incidents/${alsIncidentId}/candidates`);
    expect(alsRes.body.candidates).toHaveLength(0);
  });

  it('assigns an ambulance atomically: status flips, incident updates, audit trail records it', async () => {
    const { agent, providerId } = await setupProviderAndDispatcher();
    const ambulanceId = await createAmbulanceAt(providerId, 'MB-01', 'ALS', NEAR_AMBULANCE);
    const incidentId = await createIncidentAt(agent, 'cardiac');

    const res = await agent.post(`/api/incidents/${incidentId}/assign`).send({ ambulanceId });

    expect(res.status).toBe(200);
    expect(res.body.incident.status).toBe('assigned');
    expect(res.body.incident.assigned_ambulance_id).toBe(ambulanceId);

    const [[ambulanceRow]] = await pool.query('SELECT status FROM ambulances WHERE id = ?', [ambulanceId]);
    expect(ambulanceRow.status).toBe('dispatched');

    const [events] = await pool.query(
      'SELECT event_type FROM incident_events WHERE incident_id = ? ORDER BY id',
      [incidentId]
    );
    expect(events.map((e) => e.event_type)).toEqual(['created', 'triage_suggested', 'assigned']);
  });

  it('rejects a second dispatcher trying to claim an already-assigned ambulance (no double-booking)', async () => {
    const { agent, providerId } = await setupProviderAndDispatcher();
    const ambulanceId = await createAmbulanceAt(providerId, 'MB-01', 'ALS', NEAR_AMBULANCE);
    const incidentA = await createIncidentAt(agent, 'cardiac');
    const incidentB = await createIncidentAt(agent, 'cardiac');

    const firstAssign = await agent.post(`/api/incidents/${incidentA}/assign`).send({ ambulanceId });
    expect(firstAssign.status).toBe(200);

    const secondAssign = await agent.post(`/api/incidents/${incidentB}/assign`).send({ ambulanceId });
    expect(secondAssign.status).toBe(409);

    // incident B must remain unassigned, not partially updated.
    const [[incidentBRow]] = await pool.query('SELECT status, assigned_ambulance_id FROM incidents WHERE id = ?', [
      incidentB,
    ]);
    expect(incidentBRow.status).toBe('reported');
    expect(incidentBRow.assigned_ambulance_id).toBeNull();
  });

  it('rejects assigning a BLS ambulance to an ALS-required incident', async () => {
    const { agent, providerId } = await setupProviderAndDispatcher();
    const ambulanceId = await createAmbulanceAt(providerId, 'MB-01', 'BLS', NEAR_AMBULANCE);
    const incidentId = await createIncidentAt(agent, 'cardiac'); // requires ALS

    const res = await agent.post(`/api/incidents/${incidentId}/assign`).send({ ambulanceId });
    expect(res.status).toBe(400);

    const [[ambulanceRow]] = await pool.query('SELECT status FROM ambulances WHERE id = ?', [ambulanceId]);
    expect(ambulanceRow.status).toBe('available'); // untouched
  });

  it('blocks a non-dispatcher from viewing candidates or assigning (RBAC)', async () => {
    const { agent: dispatcherAgent, providerId } = await setupProviderAndDispatcher();
    const ambulanceId = await createAmbulanceAt(providerId, 'MB-01', 'ALS', NEAR_AMBULANCE);
    const incidentId = await createIncidentAt(dispatcherAgent, 'cardiac');

    await userService.createUser({
      name: 'Crew',
      email: 'crew@test.local',
      password: 'password-123',
      role: ROLES.CREW,
      providerId,
    });
    const crewAgent = request.agent(app);
    await crewAgent.post('/api/auth/login').send({ email: 'crew@test.local', password: 'password-123' });

    const candidatesRes = await crewAgent.get(`/api/incidents/${incidentId}/candidates`);
    expect(candidatesRes.status).toBe(403);

    const assignRes = await crewAgent.post(`/api/incidents/${incidentId}/assign`).send({ ambulanceId });
    expect(assignRes.status).toBe(403);
  });
});
