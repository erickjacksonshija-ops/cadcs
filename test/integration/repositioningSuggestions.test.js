require('../helpers/loadTestEnv');
const request = require('supertest');
const resetDb = require('../helpers/resetDb');
const pool = require('../../src/config/db');
const sessionStore = require('../../src/config/sessionStore');
const createApp = require('../../src/app');
const userService = require('../../src/services/userService');
const incidentService = require('../../src/services/incidentService');
const { ROLES } = require('../../src/config/roles');

const app = createApp();

const AMBULANCE_LOCATION = { lat: -8.9094, lng: 33.4607 };
// ~18km from the ambulance -- well past the 5km coverage-gap threshold.
const GAP_LOCATION = { lat: -9.05, lng: 33.55 };

async function loginAsAdmin() {
  const adminAgent = request.agent(app);
  await userService.createUser({
    name: 'Admin',
    email: 'admin@test.local',
    password: 'password-123',
    role: ROLES.ADMIN,
  });
  await adminAgent.post('/api/auth/login').send({ email: 'admin@test.local', password: 'password-123' });
  return adminAgent;
}

describe('proactive fleet repositioning suggestions (integration)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  it('returns no suggestions when there is no incident history', async () => {
    const adminAgent = await loginAsAdmin();
    const res = await adminAgent.get('/api/admin/analytics/repositioning');
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
  });

  it('suggests repositioning the nearest idle ambulance toward a real coverage gap', async () => {
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

    const [ambulanceResult] = await pool.query(
      `INSERT INTO ambulances (provider_id, call_sign, capability_level, status, current_location, last_ping_at)
       VALUES (:providerId, 'MB-01', 'ALS', 'available', ST_SRID(POINT(:lat, :lng), 4326), NOW())`,
      { providerId, ...AMBULANCE_LOCATION }
    );
    const ambulanceId = ambulanceResult.insertId;

    // Three reports clustered at the same distant, uncovered spot.
    for (let i = 0; i < 3; i++) {
      await incidentService.createIncident({
        lat: GAP_LOCATION.lat + i * 0.0005,
        lng: GAP_LOCATION.lng + i * 0.0005,
        chiefComplaint: 'trauma',
        createdBy: dispatcher.id,
      });
    }

    const adminAgent = await loginAsAdmin();
    const res = await adminAgent.get('/api/admin/analytics/repositioning');
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toHaveLength(1);
    expect(res.body.suggestions[0].ambulanceId).toBe(ambulanceId);
    expect(res.body.suggestions[0].callSign).toBe('MB-01');
    expect(res.body.suggestions[0].gapIncidentCount).toBe(3);
    expect(res.body.suggestions[0].distanceKm).toBeGreaterThan(5);
  });

  it('blocks a non-admin role from the repositioning endpoint (RBAC)', async () => {
    const [providerResult] = await pool.query(
      "INSERT INTO providers (name, type) VALUES ('Test Provider', 'private')"
    );
    await userService.createUser({
      name: 'Dispatcher',
      email: 'dispatcher@test.local',
      password: 'password-123',
      role: ROLES.DISPATCHER,
      providerId: providerResult.insertId,
    });
    const dispatcherAgent = request.agent(app);
    await dispatcherAgent.post('/api/auth/login').send({ email: 'dispatcher@test.local', password: 'password-123' });

    const res = await dispatcherAgent.get('/api/admin/analytics/repositioning');
    expect(res.status).toBe(403);
  });
});
