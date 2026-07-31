require('../helpers/loadTestEnv');
const request = require('supertest');
const resetDb = require('../helpers/resetDb');
const pool = require('../../src/config/db');
const sessionStore = require('../../src/config/sessionStore');
const createApp = require('../../src/app');
const userService = require('../../src/services/userService');
const { ROLES } = require('../../src/config/roles');

const app = createApp();

const BASE_LOCATION = { lat: -8.9094, lng: 33.4607 };

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
  await userService.createUser({
    name: 'Crew',
    email: 'crew@test.local',
    password: 'password-123',
    role: ROLES.CREW,
    providerId,
  });

  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email: 'dispatcher@test.local', password: 'password-123' });

  const crewAgent = request.agent(app);
  await crewAgent.post('/api/auth/login').send({ email: 'crew@test.local', password: 'password-123' });

  return { agent, crewAgent };
}

describe('duplicate/related-incident detection (integration)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  it('flags a recently reported open incident within 300m as a possible duplicate', async () => {
    const { agent } = await setup();
    const original = await agent.post('/api/incidents').send({
      lat: BASE_LOCATION.lat,
      lng: BASE_LOCATION.lng,
      chiefComplaint: 'trauma',
    });
    const incidentId = original.body.incident.id;

    // ~50m offset -- well within the 300m radius.
    const res = await agent.get(`/api/incidents/nearby-open?lat=${BASE_LOCATION.lat + 0.0004}&lng=${BASE_LOCATION.lng + 0.0003}`);
    expect(res.status).toBe(200);
    expect(res.body.incidents).toHaveLength(1);
    expect(res.body.incidents[0].id).toBe(incidentId);
    expect(res.body.incidents[0].distance_meters).toBeLessThan(300);
  });

  it('does not flag an incident more than 300m away', async () => {
    const { agent } = await setup();
    await agent.post('/api/incidents').send({
      lat: BASE_LOCATION.lat,
      lng: BASE_LOCATION.lng,
      chiefComplaint: 'trauma',
    });

    // ~1.1km offset (0.01 degrees latitude).
    const res = await agent.get(`/api/incidents/nearby-open?lat=${BASE_LOCATION.lat + 0.01}&lng=${BASE_LOCATION.lng}`);
    expect(res.status).toBe(200);
    expect(res.body.incidents).toHaveLength(0);
  });

  it('does not flag a nearby incident reported more than 20 minutes ago', async () => {
    const { agent } = await setup();
    const original = await agent.post('/api/incidents').send({
      lat: BASE_LOCATION.lat,
      lng: BASE_LOCATION.lng,
      chiefComplaint: 'trauma',
    });
    await pool.query("UPDATE incidents SET reported_at = DATE_SUB(NOW(), INTERVAL 25 MINUTE) WHERE id = :id", {
      id: original.body.incident.id,
    });

    const res = await agent.get(`/api/incidents/nearby-open?lat=${BASE_LOCATION.lat}&lng=${BASE_LOCATION.lng}`);
    expect(res.status).toBe(200);
    expect(res.body.incidents).toHaveLength(0);
  });

  it('does not flag a duplicate that has already been cancelled', async () => {
    const { agent } = await setup();
    const original = await agent.post('/api/incidents').send({
      lat: BASE_LOCATION.lat,
      lng: BASE_LOCATION.lng,
      chiefComplaint: 'trauma',
    });
    await agent.post(`/api/incidents/${original.body.incident.id}/cancel`).send({ reason: 'false alarm' });

    const res = await agent.get(`/api/incidents/nearby-open?lat=${BASE_LOCATION.lat}&lng=${BASE_LOCATION.lng}`);
    expect(res.status).toBe(200);
    expect(res.body.incidents).toHaveLength(0);
  });

  it('blocks crew from the dispatcher-only duplicate-check endpoint (RBAC)', async () => {
    const { crewAgent } = await setup();
    const res = await crewAgent.get(`/api/incidents/nearby-open?lat=${BASE_LOCATION.lat}&lng=${BASE_LOCATION.lng}`);
    expect(res.status).toBe(403);
  });
});
