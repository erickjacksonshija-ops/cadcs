// Isolated from geocode.test.js: deliberately points Nominatim at an
// unreachable address (overriding .env.test's real NOMINATIM_BASE_URL via
// jest.resetModules(), same pattern as dispatchOsrmFallback.test.js) to
// prove the empty-result fallback genuinely activates when Nominatim is
// down -- rather than relying on Nominatim happening to be unreachable by
// accident. This repo's dev environment runs a real self-hosted Nominatim
// (see docker-compose.yml), so that assumption would be actively wrong
// here, not just fragile.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env.test'), override: true });

const request = require('supertest');

describe('geocode search -- Nominatim-down fallback (integration)', () => {
  let app;
  let pool;
  let sessionStore;
  let userService;
  let ROLES;

  beforeAll(async () => {
    process.env.NOMINATIM_BASE_URL = 'http://localhost:59998'; // nothing listens here
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
    delete process.env.NOMINATIM_BASE_URL;
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  it('degrades to an empty, non-error result when Nominatim is unreachable', async () => {
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

    const res = await agent.get('/api/geocode/search?q=Mbeya');
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    expect(res.body.unavailable).toBe(true);
  });
});
