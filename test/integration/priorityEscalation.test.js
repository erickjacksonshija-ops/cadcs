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

async function setup({ ambulanceCapability = 'ALS' } = {}) {
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
  const crewUser = await userService.createUser({
    name: 'Crew',
    email: 'crew@test.local',
    password: 'password-123',
    role: ROLES.CREW,
    providerId,
  });

  const [ambulanceResult] = await pool.query(
    `INSERT INTO ambulances (provider_id, call_sign, capability_level, status, current_location, last_ping_at, current_crew_user_id)
     VALUES (:providerId, 'MB-01', :capability, 'available', ST_SRID(POINT(:lat, :lng), 4326), NOW(), :crewId)`,
    { providerId, capability: ambulanceCapability, ...AMBULANCE_LOCATION, crewId: crewUser.id }
  );
  const ambulanceId = ambulanceResult.insertId;

  const dispatcherAgent = request.agent(app);
  await dispatcherAgent.post('/api/auth/login').send({ email: 'dispatcher@test.local', password: 'password-123' });

  const crewAgent = request.agent(app);
  await crewAgent.post('/api/auth/login').send({ email: 'crew@test.local', password: 'password-123' });

  const incidentRes = await dispatcherAgent.post('/api/incidents').send({
    lat: INCIDENT_LOCATION.lat,
    lng: INCIDENT_LOCATION.lng,
    chiefComplaint: 'trauma', // trauma -> P2/BLS suggestion, so escalating to P1 is a genuine change
  });
  const incidentId = incidentRes.body.incident.id;

  return { dispatcherAgent, crewAgent, incidentId, ambulanceId };
}

describe('mid-incident priority escalation (integration)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  it('escalates priority with a required reason, and logs it to the audit trail', async () => {
    const { dispatcherAgent, incidentId } = await setup();

    const res = await dispatcherAgent
      .post(`/api/incidents/${incidentId}/priority`)
      .send({ priority: 'P1', reason: 'caller reports patient now unresponsive' });
    expect(res.status).toBe(200);
    expect(res.body.incident.priority).toBe('P1');

    const events = await dispatcherAgent.get(`/api/incidents/${incidentId}/events`);
    const priorityEvent = events.body.events.find((e) => e.event_type === 'priority_changed');
    expect(priorityEvent).toBeTruthy();
    const metadata = typeof priorityEvent.metadata === 'string' ? JSON.parse(priorityEvent.metadata) : priorityEvent.metadata;
    expect(metadata).toMatchObject({ from: 'P2', to: 'P1', reason: 'caller reports patient now unresponsive' });
  });

  it('rejects a reason shorter than 3 characters', async () => {
    const { dispatcherAgent, incidentId } = await setup();
    const res = await dispatcherAgent.post(`/api/incidents/${incidentId}/priority`).send({ priority: 'P1', reason: 'hi' });
    expect(res.status).toBe(400);
  });

  it('rejects setting the same priority the incident already has', async () => {
    const { dispatcherAgent, incidentId } = await setup();
    const res = await dispatcherAgent
      .post(`/api/incidents/${incidentId}/priority`)
      .send({ priority: 'P2', reason: 'no actual change' });
    expect(res.status).toBe(400);
  });

  it('rejects a priority change on a cancelled incident', async () => {
    const { dispatcherAgent, incidentId } = await setup();
    await dispatcherAgent.post(`/api/incidents/${incidentId}/cancel`).send({ reason: 'false alarm' });

    const res = await dispatcherAgent
      .post(`/api/incidents/${incidentId}/priority`)
      .send({ priority: 'P1', reason: 'trying anyway' });
    expect(res.status).toBe(400);
  });

  it('warns when escalating to P1 while a BLS unit is assigned', async () => {
    const { dispatcherAgent, incidentId, ambulanceId } = await setup({ ambulanceCapability: 'BLS' });
    await dispatcherAgent.post(`/api/incidents/${incidentId}/assign`).send({ ambulanceId });

    const res = await dispatcherAgent
      .post(`/api/incidents/${incidentId}/priority`)
      .send({ priority: 'P1', reason: 'patient deteriorating' });
    expect(res.status).toBe(200);
    expect(res.body.capabilityWarning).toMatch(/BLS/);
    expect(res.body.capabilityWarning).toMatch(/MB-01/);
  });

  it('does not warn when escalating to P1 with an ALS unit already assigned', async () => {
    const { dispatcherAgent, incidentId, ambulanceId } = await setup({ ambulanceCapability: 'ALS' });
    await dispatcherAgent.post(`/api/incidents/${incidentId}/assign`).send({ ambulanceId });

    const res = await dispatcherAgent
      .post(`/api/incidents/${incidentId}/priority`)
      .send({ priority: 'P1', reason: 'patient deteriorating' });
    expect(res.status).toBe(200);
    expect(res.body.capabilityWarning).toBeNull();
  });

  it('does not warn when escalating to P1 with no ambulance assigned yet', async () => {
    const { dispatcherAgent, incidentId } = await setup();
    const res = await dispatcherAgent
      .post(`/api/incidents/${incidentId}/priority`)
      .send({ priority: 'P1', reason: 'patient deteriorating' });
    expect(res.status).toBe(200);
    expect(res.body.capabilityWarning).toBeNull();
  });

  it('blocks crew from changing incident priority (RBAC)', async () => {
    const { crewAgent, incidentId } = await setup();
    const res = await crewAgent.post(`/api/incidents/${incidentId}/priority`).send({ priority: 'P1', reason: 'not allowed' });
    expect(res.status).toBe(403);
  });
});
