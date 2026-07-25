require('../helpers/loadTestEnv');
const request = require('supertest');
const resetDb = require('../helpers/resetDb');
const pool = require('../../src/config/db');
const sessionStore = require('../../src/config/sessionStore');
const createApp = require('../../src/app');
const userService = require('../../src/services/userService');
const { ROLES } = require('../../src/config/roles');

const app = createApp();

async function setup() {
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
     VALUES (:providerId, 'MB-01', 'ALS', 'available', ST_SRID(POINT(-8.912, 33.463), 4326), NOW(), :crewId)`,
    { providerId, crewId: crewUser.id }
  );
  const ambulanceId = ambulanceResult.insertId;

  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email: 'dispatcher@test.local', password: 'password-123' });

  return { agent, providerId, ambulanceId };
}

async function createIncident(agent, chiefComplaint = 'trauma') {
  const res = await agent.post('/api/incidents').send({
    lat: -8.9094,
    lng: 33.4607,
    chiefComplaint,
  });
  return res.body.incident.id;
}

describe('incident cancellation (integration)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  it('cancels a reported incident with a reason, recorded in the audit trail', async () => {
    const { agent } = await setup();
    const incidentId = await createIncident(agent);

    const res = await agent.post(`/api/incidents/${incidentId}/cancel`).send({ reason: 'Duplicate call' });
    expect(res.status).toBe(200);
    expect(res.body.incident.status).toBe('cancelled');
    expect(res.body.incident.cancel_reason).toBe('Duplicate call');

    const [events] = await pool.query(
      "SELECT event_type FROM incident_events WHERE incident_id = ? AND event_type = 'cancelled'",
      [incidentId]
    );
    expect(events).toHaveLength(1);
  });

  it('releases the claimed ambulance back to available when cancelling an assigned incident', async () => {
    const { agent, ambulanceId } = await setup();
    const incidentId = await createIncident(agent);
    await agent.post(`/api/incidents/${incidentId}/assign`).send({ ambulanceId });

    const [[beforeCancel]] = await pool.query('SELECT status FROM ambulances WHERE id = ?', [ambulanceId]);
    expect(beforeCancel.status).toBe('dispatched');

    const res = await agent.post(`/api/incidents/${incidentId}/cancel`).send({ reason: 'False alarm' });
    expect(res.status).toBe(200);

    const [[afterCancel]] = await pool.query('SELECT status FROM ambulances WHERE id = ?', [ambulanceId]);
    expect(afterCancel.status).toBe('available');
  });

  it('rejects cancelling an incident once a crew is actively responding (en_route or later)', async () => {
    const { agent, ambulanceId } = await setup();
    const incidentId = await createIncident(agent);
    await agent.post(`/api/incidents/${incidentId}/assign`).send({ ambulanceId });

    const [[ambulanceRow]] = await pool.query('SELECT current_crew_user_id FROM ambulances WHERE id = ?', [
      ambulanceId,
    ]);
    const crewAgent = request.agent(app);
    await crewAgent.post('/api/auth/login').send({ email: 'crew@test.local', password: 'password-123' });
    await crewAgent.post(`/api/incidents/${incidentId}/status`).send({ status: 'en_route' });

    const res = await agent.post(`/api/incidents/${incidentId}/cancel`).send({ reason: 'Too late now' });
    expect(res.status).toBe(400);
    expect(ambulanceRow.current_crew_user_id).toBeTruthy();

    const [[incidentRow]] = await pool.query('SELECT status FROM incidents WHERE id = ?', [incidentId]);
    expect(incidentRow.status).toBe('en_route'); // untouched
  });

  it('rejects cancellation without a reason', async () => {
    const { agent } = await setup();
    const incidentId = await createIncident(agent);
    const res = await agent.post(`/api/incidents/${incidentId}/cancel`).send({});
    expect(res.status).toBe(400);
  });

  it('blocks a non-dispatcher from cancelling an incident (RBAC)', async () => {
    const { agent, providerId } = await setup();
    const incidentId = await createIncident(agent);

    const crewAgent = request.agent(app);
    await crewAgent.post('/api/auth/login').send({ email: 'crew@test.local', password: 'password-123' });

    const res = await crewAgent.post(`/api/incidents/${incidentId}/cancel`).send({ reason: 'Nope' });
    expect(res.status).toBe(403);
    expect(providerId).toBeTruthy();
  });
});
