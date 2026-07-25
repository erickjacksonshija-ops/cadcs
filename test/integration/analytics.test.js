require('../helpers/loadTestEnv');
const request = require('supertest');
const resetDb = require('../helpers/resetDb');
const pool = require('../../src/config/db');
const sessionStore = require('../../src/config/sessionStore');
const createApp = require('../../src/app');
const userService = require('../../src/services/userService');
const incidentService = require('../../src/services/incidentService');
const dispatchService = require('../../src/services/dispatchService');
const { ROLES } = require('../../src/config/roles');

const app = createApp();

async function setupAndCloseOneIncident() {
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

  const [hospitalResult] = await pool.query(
    `INSERT INTO hospitals (name, location, address) VALUES ('Test Hospital', ST_SRID(POINT(-8.902, 33.452), 4326), 'Mbeya')`
  );
  const hospitalId = hospitalResult.insertId;

  const incident = await incidentService.createIncident({
    lat: -8.9094,
    lng: 33.4607,
    chiefComplaint: 'cardiac',
    redFlags: {},
    createdBy: dispatcher.id,
  });

  await dispatchService.assignAmbulance(incident.id, ambulanceId, dispatcher.id);
  await dispatchService.updateMissionStatus(incident.id, crewUser.id, 'en_route');
  await dispatchService.updateMissionStatus(incident.id, crewUser.id, 'on_scene');
  await dispatchService.updateMissionStatus(incident.id, crewUser.id, 'transporting', hospitalId);
  await dispatchService.updateMissionStatus(incident.id, crewUser.id, 'at_hospital');
  await dispatchService.updateMissionStatus(incident.id, crewUser.id, 'closed');

  return { providerId };
}

describe('analytics dashboard (integration)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  it('computes real response-time figures from a closed incident, not fabricated ones', async () => {
    await setupAndCloseOneIncident();

    const adminAgent = request.agent(app);
    await userService.createUser({
      name: 'Admin',
      email: 'admin@test.local',
      password: 'password-123',
      role: ROLES.ADMIN,
    });
    await adminAgent.post('/api/auth/login').send({ email: 'admin@test.local', password: 'password-123' });

    const res = await adminAgent.get('/api/admin/analytics');
    expect(res.status).toBe(200);
    expect(res.body.totalClosedIncidents).toBe(1);
    expect(res.body.callToScene.count).toBe(1);
    expect(res.body.callToScene.meanSeconds).toBeGreaterThan(0);
    expect(res.body.volumeByPriority.P2).toBe(1); // cardiac, no red flags -> P2 per triageService
    expect(res.body.responseTimeBenchmarkSeconds).toBe(480);
    expect(res.body.benchmarkMet.total).toBe(1);
  });

  it('returns zeroed-out figures gracefully when there are no closed incidents yet', async () => {
    const adminAgent = request.agent(app);
    await userService.createUser({
      name: 'Admin',
      email: 'admin@test.local',
      password: 'password-123',
      role: ROLES.ADMIN,
    });
    await adminAgent.post('/api/auth/login').send({ email: 'admin@test.local', password: 'password-123' });

    const res = await adminAgent.get('/api/admin/analytics');
    expect(res.status).toBe(200);
    expect(res.body.totalClosedIncidents).toBe(0);
    expect(res.body.callToScene.count).toBe(0);
    expect(res.body.callToScene.meanSeconds).toBeNull();
    expect(res.body.benchmarkMet.percent).toBeNull();
  });

  it('blocks non-admin roles from the analytics endpoint (RBAC)', async () => {
    const { providerId } = await setupAndCloseOneIncident();
    await userService.createUser({
      name: 'Dispatcher Two',
      email: 'dispatcher2@test.local',
      password: 'password-123',
      role: ROLES.DISPATCHER,
      providerId,
    });
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: 'dispatcher2@test.local', password: 'password-123' });

    const res = await agent.get('/api/admin/analytics');
    expect(res.status).toBe(403);
  });
});
