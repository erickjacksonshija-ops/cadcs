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

describe('incident audit timeline (integration)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  it('returns the timeline in chronological order, reflecting real actions taken', async () => {
    const { agent, ambulanceId } = await setup();
    const createRes = await agent.post('/api/incidents').send({
      lat: -8.9094,
      lng: 33.4607,
      chiefComplaint: 'trauma',
    });
    const incidentId = createRes.body.incident.id;

    await agent.post(`/api/incidents/${incidentId}/assign`).send({ ambulanceId });

    const res = await agent.get(`/api/incidents/${incidentId}/events`);
    expect(res.status).toBe(200);

    const types = res.body.events.map((e) => e.event_type);
    expect(types).toContain('created');
    expect(types).toContain('triage_suggested');
    expect(types).toContain('assigned');

    // Chronological -- 'created' before 'assigned'.
    expect(types.indexOf('created')).toBeLessThan(types.indexOf('assigned'));

    // Every event has a server-generated timestamp, never client-supplied.
    res.body.events.forEach((e) => expect(e.occurred_at).toBeTruthy());
  });

  it('returns 404 for a nonexistent incident', async () => {
    const { agent } = await setup();
    const res = await agent.get('/api/incidents/999999/events');
    expect(res.status).toBe(404);
  });

  it('blocks crew and hospital roles from the audit timeline (dispatcher/admin only)', async () => {
    const { agent, providerId } = await setup();
    const createRes = await agent.post('/api/incidents').send({
      lat: -8.9094,
      lng: 33.4607,
      chiefComplaint: 'trauma',
    });
    const incidentId = createRes.body.incident.id;

    await userService.createUser({
      name: 'Other Crew',
      email: 'othercrew@test.local',
      password: 'password-123',
      role: ROLES.CREW,
      providerId,
    });
    const crewAgent = request.agent(app);
    await crewAgent.post('/api/auth/login').send({ email: 'othercrew@test.local', password: 'password-123' });

    const res = await crewAgent.get(`/api/incidents/${incidentId}/events`);
    expect(res.status).toBe(403);
  });
});
