// Isolated from the other integration tests: this file deliberately runs
// with the PRODUCTION rate-limit threshold (not .env.test's relaxed
// LOGIN_RATE_LIMIT_MAX), by overriding the env var and re-requiring the
// app fresh via jest.resetModules(). Without this, the limiter's
// in-memory counter would never actually get proven to trip.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env.test'), override: true });

const request = require('supertest');

describe('login rate limiting (integration)', () => {
  let app;
  let pool;
  let sessionStore;

  beforeAll(async () => {
    process.env.LOGIN_RATE_LIMIT_MAX = '3';
    // resetDb is also required only after resetModules -- otherwise it
    // would create its own, separate pool instance (from before the
    // reset) that never gets closed, leaking a connection handle.
    jest.resetModules();
    pool = require('../../src/config/db');
    sessionStore = require('../../src/config/sessionStore');
    const createApp = require('../../src/app');
    const resetDb = require('../helpers/resetDb');
    app = createApp();
    await resetDb();
  });

  afterAll(async () => {
    delete process.env.LOGIN_RATE_LIMIT_MAX;
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  it('allows attempts under the threshold and blocks with 429 once exceeded', async () => {
    const agent = request.agent(app);

    for (let i = 0; i < 3; i++) {
      const res = await agent.post('/api/auth/login').send({ email: 'nobody@test.local', password: 'wrong' });
      expect(res.status).toBe(401); // wrong credentials, but not yet rate-limited
    }

    const fourthAttempt = await agent
      .post('/api/auth/login')
      .send({ email: 'nobody@test.local', password: 'wrong' });
    expect(fourthAttempt.status).toBe(429);
    expect(fourthAttempt.body.error).toMatch(/too many/i);
  });
});
