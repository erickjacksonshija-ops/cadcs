require('../helpers/loadTestEnv');
const request = require('supertest');
const resetDb = require('../helpers/resetDb');
const pool = require('../../src/config/db');
const sessionStore = require('../../src/config/sessionStore');
const createApp = require('../../src/app');
const userService = require('../../src/services/userService');
const { ROLES } = require('../../src/config/roles');

const app = createApp();

async function createDispatcherAgent() {
  const [providerResult] = await pool.query(
    "INSERT INTO providers (name, type) VALUES ('Test EMS Provider', 'private')"
  );
  await userService.createUser({
    name: 'Dispatcher',
    email: 'dispatcher@test.local',
    password: 'password-123',
    role: ROLES.DISPATCHER,
    providerId: providerResult.insertId,
  });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email: 'dispatcher@test.local', password: 'password-123' });
  return { agent, providerId: providerResult.insertId };
}

describe('incident intake (integration)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  it('creates an incident, applies the triage suggestion, and round-trips lat/lng correctly', async () => {
    const { agent } = await createDispatcherAgent();

    const res = await agent.post('/api/incidents').send({
      lat: -8.9094,
      lng: 33.4607,
      locationDescription: 'Near Mbeya market, past the bridge',
      chiefComplaint: 'cardiac',
      redFlags: {},
      patientNotes: 'Chest pain, 45yo male',
    });

    expect(res.status).toBe(201);
    const incident = res.body.incident;
    expect(incident.suggested_priority).toBe('P2');
    expect(incident.suggested_capability).toBe('ALS');
    expect(incident.priority).toBe('P2');
    expect(incident.required_capability).toBe('ALS');
    expect(incident.lat).toBeCloseTo(-8.9094, 4);
    expect(incident.lng).toBeCloseTo(33.4607, 4);
    expect(incident.status).toBe('reported');

    const [events] = await pool.query(
      'SELECT event_type FROM incident_events WHERE incident_id = ? ORDER BY id',
      [incident.id]
    );
    expect(events.map((e) => e.event_type)).toEqual(['created', 'triage_suggested']);
  });

  it('records a priority_overridden event when the dispatcher overrides the suggestion', async () => {
    const { agent } = await createDispatcherAgent();

    const res = await agent.post('/api/incidents').send({
      lat: -8.9,
      lng: 33.45,
      chiefComplaint: 'other',
      redFlags: {},
      priorityOverride: 'P1',
    });

    expect(res.status).toBe(201);
    expect(res.body.incident.suggested_priority).toBe('P3');
    expect(res.body.incident.priority).toBe('P1');

    const [events] = await pool.query(
      'SELECT event_type FROM incident_events WHERE incident_id = ? ORDER BY id',
      [res.body.incident.id]
    );
    expect(events.map((e) => e.event_type)).toEqual(['created', 'triage_suggested', 'priority_overridden']);
  });

  it('P1 red flags win regardless of chief complaint, end to end', async () => {
    const { agent } = await createDispatcherAgent();

    const res = await agent.post('/api/incidents').send({
      lat: -8.9,
      lng: 33.45,
      chiefComplaint: 'other',
      redFlags: { unconscious: true },
    });

    expect(res.body.incident.priority).toBe('P1');
    expect(res.body.incident.required_capability).toBe('ALS');
  });

  it('rejects an invalid chief complaint at the API layer', async () => {
    const { agent } = await createDispatcherAgent();
    const res = await agent.post('/api/incidents').send({
      lat: -8.9,
      lng: 33.45,
      chiefComplaint: 'not-a-category',
    });
    expect(res.status).toBe(400);
  });

  it('lists and fetches created incidents, and 404s for an unknown id', async () => {
    const { agent } = await createDispatcherAgent();
    const createRes = await agent.post('/api/incidents').send({
      lat: -8.9,
      lng: 33.45,
      chiefComplaint: 'trauma',
    });
    const id = createRes.body.incident.id;

    const listRes = await agent.get('/api/incidents');
    expect(listRes.status).toBe(200);
    expect(listRes.body.incidents).toHaveLength(1);

    const getRes = await agent.get(`/api/incidents/${id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.incident.id).toBe(id);

    const missingRes = await agent.get('/api/incidents/999999');
    expect(missingRes.status).toBe(404);
  });

  it('blocks a hospital_staff user from creating an incident (RBAC)', async () => {
    const [hospitalResult] = await pool.query(
      "INSERT INTO hospitals (name, location, address) VALUES ('Test Hospital', ST_SRID(POINT(-8.9, 33.45), 4326), 'Test')"
    );
    await userService.createUser({
      name: 'Hospital Staff',
      email: 'hospitalstaff@test.local',
      password: 'password-123',
      role: ROLES.HOSPITAL_STAFF,
      hospitalId: hospitalResult.insertId,
    });
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: 'hospitalstaff@test.local', password: 'password-123' });

    const res = await agent.post('/api/incidents').send({
      lat: -8.9,
      lng: 33.45,
      chiefComplaint: 'trauma',
    });
    expect(res.status).toBe(403);
  });
});
