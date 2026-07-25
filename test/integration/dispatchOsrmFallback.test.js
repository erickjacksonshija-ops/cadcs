// Isolated from the other dispatch tests: deliberately points OSRM at an
// unreachable address (overriding .env.test's real OSRM_BASE_URL via
// jest.resetModules(), same pattern as loginRateLimit.test.js) to prove
// the Haversine fallback genuinely activates when OSRM is down -- rather
// than relying on OSRM happening to be unreachable by accident, as the
// original version of this test unintentionally did.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env.test'), override: true });

const request = require('supertest');

const INCIDENT_LOCATION = { lat: -8.9094, lng: 33.4607 };
const NEAR_AMBULANCE = { lat: -8.912, lng: 33.463 };
const FAR_AMBULANCE = { lat: -9.05, lng: 33.6 };

describe('dispatch OSRM-down fallback (integration)', () => {
  let app;
  let pool;
  let sessionStore;
  let userService;
  let ROLES;

  beforeAll(async () => {
    process.env.OSRM_BASE_URL = 'http://localhost:59999'; // nothing listens here
    // resetDb is also required only after resetModules -- otherwise it
    // would create its own, separate pool instance (from before the
    // reset) that never gets closed, leaking a connection handle.
    jest.resetModules();
    pool = require('../../src/config/db');
    sessionStore = require('../../src/config/sessionStore');
    userService = require('../../src/services/userService');
    ({ ROLES } = require('../../src/config/roles'));
    const createApp = require('../../src/app');
    const resetDb = require('../helpers/resetDb');
    app = createApp();
    await resetDb();
  });

  afterAll(async () => {
    delete process.env.OSRM_BASE_URL;
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  it('falls back to Haversine ranking, flagged, when OSRM is unreachable', async () => {
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

    const [farResult] = await pool.query(
      `INSERT INTO ambulances (provider_id, call_sign, capability_level, status, current_location, last_ping_at)
       VALUES (:providerId, 'MB-FAR', 'BLS', 'available', ST_SRID(POINT(:lat, :lng), 4326), NOW())`,
      { providerId, ...FAR_AMBULANCE }
    );
    const [nearResult] = await pool.query(
      `INSERT INTO ambulances (provider_id, call_sign, capability_level, status, current_location, last_ping_at)
       VALUES (:providerId, 'MB-NEAR', 'BLS', 'available', ST_SRID(POINT(:lat, :lng), 4326), NOW())`,
      { providerId, ...NEAR_AMBULANCE }
    );

    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: 'dispatcher@test.local', password: 'password-123' });
    const incidentRes = await agent.post('/api/incidents').send({
      lat: INCIDENT_LOCATION.lat,
      lng: INCIDENT_LOCATION.lng,
      chiefComplaint: 'trauma',
    });
    const incidentId = incidentRes.body.incident.id;

    const res = await agent.get(`/api/incidents/${incidentId}/candidates`);

    expect(res.status).toBe(200);
    expect(res.body.routingSource).toBe('haversine_fallback');
    expect(res.body.candidates.map((c) => c.ambulanceId)).toEqual([nearResult.insertId, farResult.insertId]);
    expect(res.body.candidates[0].etaSeconds).toBeNull();
    expect(res.body.candidates[0].distanceMeters).toBeLessThan(res.body.candidates[1].distanceMeters);
  });
});
