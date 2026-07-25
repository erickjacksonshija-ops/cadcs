require('../helpers/loadTestEnv');
const request = require('supertest');
const resetDb = require('../helpers/resetDb');
const pool = require('../../src/config/db');
const sessionStore = require('../../src/config/sessionStore');
const createApp = require('../../src/app');
const userService = require('../../src/services/userService');
const { ROLES } = require('../../src/config/roles');

const app = createApp();

const INCIDENT_LOCATION = { lat: -8.9094, lng: 33.4607 };
const AMBULANCE_LOCATION = { lat: -8.912, lng: 33.463 };

async function setup() {
  const [providerResult] = await pool.query(
    "INSERT INTO providers (name, type) VALUES ('Test Provider', 'private')"
  );
  const providerId = providerResult.insertId;

  const dispatcher = await userService.createUser({
    name: 'Dispatcher',
    email: 'dispatcher@test.local',
    password: 'password-123',
    role: ROLES.DISPATCHER,
    providerId,
  });
  const crew = await userService.createUser({
    name: 'Crew',
    email: 'crew@test.local',
    password: 'password-123',
    role: ROLES.CREW,
    providerId,
  });

  const [ambulanceResult] = await pool.query(
    `INSERT INTO ambulances (provider_id, call_sign, capability_level, status, current_location, last_ping_at, current_crew_user_id)
     VALUES (:providerId, 'MB-01', 'ALS', 'available', ST_SRID(POINT(:lat, :lng), 4326), NOW(), :crewId)`,
    { providerId, lat: AMBULANCE_LOCATION.lat, lng: AMBULANCE_LOCATION.lng, crewId: crew.id }
  );
  const ambulanceId = ambulanceResult.insertId;

  const [hospitalResult] = await pool.query(
    `INSERT INTO hospitals (name, location, address) VALUES ('Test Hospital', ST_SRID(POINT(-8.902, 33.452), 4326), 'Mbeya')`
  );
  const hospitalId = hospitalResult.insertId;

  const dispatcherAgent = request.agent(app);
  await dispatcherAgent.post('/api/auth/login').send({ email: 'dispatcher@test.local', password: 'password-123' });

  const crewAgent = request.agent(app);
  await crewAgent.post('/api/auth/login').send({ email: 'crew@test.local', password: 'password-123' });

  const incidentRes = await dispatcherAgent.post('/api/incidents').send({
    lat: INCIDENT_LOCATION.lat,
    lng: INCIDENT_LOCATION.lng,
    chiefComplaint: 'cardiac',
    patientNotes: 'Sensitive patient detail',
    callerPhone: '+255700000000',
  });
  const incidentId = incidentRes.body.incident.id;

  await dispatcherAgent.post(`/api/incidents/${incidentId}/assign`).send({ ambulanceId });

  return { dispatcherAgent, crewAgent, providerId, ambulanceId, incidentId, hospitalId, dispatcher };
}

describe('crew mission flow (integration)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  it('returns null for /mine when the crew has no active mission', async () => {
    const [providerResult] = await pool.query(
      "INSERT INTO providers (name, type) VALUES ('Test Provider', 'private')"
    );
    await userService.createUser({
      name: 'Idle Crew',
      email: 'idlecrew@test.local',
      password: 'password-123',
      role: ROLES.CREW,
      providerId: providerResult.insertId,
    });
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: 'idlecrew@test.local', password: 'password-123' });

    const res = await agent.get('/api/incidents/mine');
    expect(res.status).toBe(200);
    expect(res.body.incident).toBeNull();
  });

  it('returns the assigned mission via /mine with patient_notes and caller_phone redacted', async () => {
    const { crewAgent, incidentId } = await setup();

    const res = await crewAgent.get('/api/incidents/mine');
    expect(res.status).toBe(200);
    expect(res.body.incident.id).toBe(incidentId);
    expect(res.body.incident.patient_notes).toBeUndefined();
    expect(res.body.incident.caller_phone).toBeUndefined();
    expect(res.body.incident.priority).toBeDefined();
    expect(res.body.incident.lat).toBeCloseTo(INCIDENT_LOCATION.lat, 4);
  });

  it('walks a mission through the full crew-driven status sequence, mirrored on the ambulance', async () => {
    const { crewAgent, ambulanceId, incidentId, hospitalId } = await setup();

    const sequence = ['en_route', 'on_scene', 'transporting', 'at_hospital', 'closed'];
    for (const status of sequence) {
      const body = status === 'transporting' ? { status, hospitalId } : { status };
      const res = await crewAgent.post(`/api/incidents/${incidentId}/status`).send(body);
      expect(res.status).toBe(200);
    }

    const [[ambulanceRow]] = await pool.query('SELECT status FROM ambulances WHERE id = ?', [ambulanceId]);
    expect(ambulanceRow.status).toBe('available'); // freed after 'closed'

    const [[incidentRow]] = await pool.query('SELECT status, closed_at FROM incidents WHERE id = ?', [incidentId]);
    expect(incidentRow.status).toBe('closed');
    expect(incidentRow.closed_at).not.toBeNull();

    const [events] = await pool.query(
      'SELECT event_type FROM incident_events WHERE incident_id = ? ORDER BY id',
      [incidentId]
    );
    expect(events.map((e) => e.event_type)).toEqual([
      'created',
      'triage_suggested',
      'assigned',
      'status_changed', // en_route
      'status_changed', // on_scene
      'hospital_notified', // logged just before the transporting status_changed
      'status_changed', // transporting
      'status_changed', // at_hospital
      'closed',
    ]);
  });

  it('rejects skipping a status step', async () => {
    const { crewAgent, incidentId } = await setup();

    // dispatched -> on_scene directly is not a legal transition (must go
    // through en_route first).
    const res = await crewAgent.post(`/api/incidents/${incidentId}/status`).send({ status: 'on_scene' });
    expect(res.status).toBe(400);
  });

  it('rejects a status update from a crew member not assigned to that ambulance', async () => {
    const { incidentId, providerId } = await setup();

    await userService.createUser({
      name: 'Other Crew',
      email: 'othercrew@test.local',
      password: 'password-123',
      role: ROLES.CREW,
      providerId,
    });
    const otherAgent = request.agent(app);
    await otherAgent.post('/api/auth/login').send({ email: 'othercrew@test.local', password: 'password-123' });

    const res = await otherAgent.post(`/api/incidents/${incidentId}/status`).send({ status: 'en_route' });
    expect(res.status).toBe(400);
  });

  it('returns a real OSRM turn-by-turn route for the assigned mission', async () => {
    const { crewAgent, incidentId } = await setup();

    const res = await crewAgent.get(`/api/incidents/${incidentId}/route`);

    expect(res.status).toBe(200);
    expect(res.body.route.durationSeconds).toBeGreaterThan(0);
    expect(res.body.route.distanceMeters).toBeGreaterThan(0);
    expect(res.body.route.geometry.type).toBe('LineString');
    expect(res.body.route.geometry.coordinates.length).toBeGreaterThan(1);
  });

  it('rejects fetching a route for an incident not assigned to the requesting crew', async () => {
    const { incidentId, providerId } = await setup();

    await userService.createUser({
      name: 'Other Crew',
      email: 'othercrew2@test.local',
      password: 'password-123',
      role: ROLES.CREW,
      providerId,
    });
    const [otherAmbulanceResult] = await pool.query(
      `INSERT INTO ambulances (provider_id, call_sign, capability_level, status, current_location, last_ping_at, current_crew_user_id)
       VALUES (:providerId, 'MB-02', 'ALS', 'available', ST_SRID(POINT(-8.9, 33.45), 4326), NOW(),
         (SELECT id FROM users WHERE email = 'othercrew2@test.local'))`,
      { providerId }
    );
    const otherAgent = request.agent(app);
    await otherAgent.post('/api/auth/login').send({ email: 'othercrew2@test.local', password: 'password-123' });

    const res = await otherAgent.get(`/api/incidents/${incidentId}/route`);
    expect(res.status).toBe(403);
    expect(otherAmbulanceResult.insertId).toBeTruthy();
  });

  it('blocks a dispatcher from using crew-only mission endpoints (RBAC)', async () => {
    const { dispatcherAgent, incidentId } = await setup();
    const res = await dispatcherAgent.post(`/api/incidents/${incidentId}/status`).send({ status: 'en_route' });
    expect(res.status).toBe(403);
  });

  it('ranks destination hospitals nearest-first by real OSRM ETA from the ambulance position', async () => {
    const { crewAgent, providerId, incidentId, hospitalId } = await setup();
    // setup()'s 'Test Hospital' sits ~1.2km from AMBULANCE_LOCATION; add a
    // second hospital far across the region so ranking is unambiguous.
    const [farHospitalResult] = await pool.query(
      `INSERT INTO hospitals (name, location, address) VALUES ('Far Hospital', ST_SRID(POINT(-9.05, 33.6), 4326), 'Songwe')`
    );
    const farHospitalId = farHospitalResult.insertId;

    const res = await crewAgent.get(`/api/incidents/${incidentId}/hospitals`);

    expect(res.status).toBe(200);
    expect(res.body.routingSource).toBe('osrm');
    expect(res.body.hospitals.map((h) => h.hospitalId)).toEqual([hospitalId, farHospitalId]);
    expect(res.body.hospitals[0].etaSeconds).toBeLessThan(res.body.hospitals[1].etaSeconds);
    expect(providerId).toBeTruthy();
  });

  it('rejects fetching ranked hospitals for an incident not assigned to the requesting crew', async () => {
    const { incidentId, providerId } = await setup();

    await userService.createUser({
      name: 'Other Crew',
      email: 'othercrew3@test.local',
      password: 'password-123',
      role: ROLES.CREW,
      providerId,
    });
    await pool.query(
      `INSERT INTO ambulances (provider_id, call_sign, capability_level, status, current_location, last_ping_at, current_crew_user_id)
       VALUES (:providerId, 'MB-03', 'ALS', 'available', ST_SRID(POINT(-8.9, 33.45), 4326), NOW(),
         (SELECT id FROM users WHERE email = 'othercrew3@test.local'))`,
      { providerId }
    );
    const otherAgent = request.agent(app);
    await otherAgent.post('/api/auth/login').send({ email: 'othercrew3@test.local', password: 'password-123' });

    const res = await otherAgent.get(`/api/incidents/${incidentId}/hospitals`);
    expect(res.status).toBe(403);
  });

  it('blocks a dispatcher from ranking hospitals (crew-only endpoint)', async () => {
    const { dispatcherAgent, incidentId } = await setup();
    const res = await dispatcherAgent.get(`/api/incidents/${incidentId}/hospitals`);
    expect(res.status).toBe(403);
  });
});
