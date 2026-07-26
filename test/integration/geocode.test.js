require('../helpers/loadTestEnv');
const request = require('supertest');
const resetDb = require('../helpers/resetDb');
const pool = require('../../src/config/db');
const sessionStore = require('../../src/config/sessionStore');
const createApp = require('../../src/app');
const userService = require('../../src/services/userService');
const { ROLES } = require('../../src/config/roles');

const app = createApp();

describe('geocode search (integration)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  // The "Nominatim is unreachable" fallback is covered separately in
  // geocodeUnavailable.test.js, which deliberately points NOMINATIM_BASE_URL
  // at a guaranteed-unreachable address rather than relying on no real
  // Nominatim happening to be running locally -- see that file's comment
  // for why (this repo's dev environment does run a real one, see
  // docker-compose.yml's nominatim service, so relying on port-silence
  // here would be flaky rather than deterministic).

  it('rejects a too-short query', async () => {
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
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: 'dispatcher@test.local', password: 'password-123' });

    const res = await agent.get('/api/geocode/search?q=a');
    expect(res.status).toBe(400);
  });

  it('blocks unauthenticated requests', async () => {
    const res = await request(app).get('/api/geocode/search?q=Mbeya');
    expect(res.status).toBe(401);
  });

  it('blocks crew from searching (dispatcher/admin only)', async () => {
    const [providerResult] = await pool.query(
      "INSERT INTO providers (name, type) VALUES ('Test Provider', 'private')"
    );
    await userService.createUser({
      name: 'Crew',
      email: 'crew@test.local',
      password: 'password-123',
      role: ROLES.CREW,
      providerId: providerResult.insertId,
    });
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: 'crew@test.local', password: 'password-123' });

    const res = await agent.get('/api/geocode/search?q=Mbeya');
    expect(res.status).toBe(403);
  });
});
