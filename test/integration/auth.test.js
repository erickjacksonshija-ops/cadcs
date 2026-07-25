require('../helpers/loadTestEnv');
const request = require('supertest');
const resetDb = require('../helpers/resetDb');
const pool = require('../../src/config/db');
const sessionStore = require('../../src/config/sessionStore');
const createApp = require('../../src/app');
const userService = require('../../src/services/userService');
const { ROLES } = require('../../src/config/roles');

const app = createApp();

async function loginAs(agent, email, password) {
  const res = await agent.post('/api/auth/login').send({ email, password });
  return res;
}

describe('auth + admin provisioning (integration)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  it('rejects login with wrong credentials, allows login with right ones, and enforces auth on /me', async () => {
    await userService.createUser({
      name: 'Admin One',
      email: 'admin@test.local',
      password: 'correct-password-1',
      role: ROLES.ADMIN,
    });

    const agent = request.agent(app);

    const badLogin = await loginAs(agent, 'admin@test.local', 'wrong-password');
    expect(badLogin.status).toBe(401);

    const meBeforeLogin = await agent.get('/api/auth/me');
    expect(meBeforeLogin.status).toBe(401);

    const goodLogin = await loginAs(agent, 'admin@test.local', 'correct-password-1');
    expect(goodLogin.status).toBe(200);
    expect(goodLogin.body.user.role).toBe('admin');

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.name).toBe('Admin One');
  });

  it('blocks a non-admin from provisioning users (RBAC)', async () => {
    const [providerResult] = await pool.query(
      "INSERT INTO providers (name, type) VALUES ('Test Provider', 'private')"
    );
    await userService.createUser({
      name: 'Dispatcher One',
      email: 'dispatcher@test.local',
      password: 'password-123',
      role: ROLES.DISPATCHER,
      providerId: providerResult.insertId,
    });

    const agent = request.agent(app);
    await loginAs(agent, 'dispatcher@test.local', 'password-123');

    const res = await agent.post('/api/admin/users').send({
      name: 'Should Not Be Created',
      email: 'nope@test.local',
      password: 'password-123',
      role: 'dispatcher',
      providerId: providerResult.insertId,
    });

    expect(res.status).toBe(403);
  });

  it('lets an admin provision a dispatcher, and never leaks the password hash', async () => {
    const [providerResult] = await pool.query(
      "INSERT INTO providers (name, type) VALUES ('Test Provider', 'private')"
    );
    await userService.createUser({
      name: 'Admin Two',
      email: 'admin2@test.local',
      password: 'correct-password-1',
      role: ROLES.ADMIN,
    });

    const agent = request.agent(app);
    await loginAs(agent, 'admin2@test.local', 'correct-password-1');

    const res = await agent.post('/api/admin/users').send({
      name: 'New Dispatcher',
      email: 'newdispatcher@test.local',
      password: 'password-123',
      role: 'dispatcher',
      providerId: providerResult.insertId,
    });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('newdispatcher@test.local');
    expect(res.body.user.password_hash).toBeUndefined();
  });

  it('rejects a dispatcher created with no providerId, at the API layer', async () => {
    await userService.createUser({
      name: 'Admin Three',
      email: 'admin3@test.local',
      password: 'correct-password-1',
      role: ROLES.ADMIN,
    });

    const agent = request.agent(app);
    await loginAs(agent, 'admin3@test.local', 'correct-password-1');

    const res = await agent.post('/api/admin/users').send({
      name: 'Bad Dispatcher',
      email: 'bad@test.local',
      password: 'password-123',
      role: 'dispatcher',
    });

    expect(res.status).toBe(400);
  });

  it('rejects a providerId that does not exist, with a safe error message (no leaked SQL)', async () => {
    await userService.createUser({
      name: 'Admin Four',
      email: 'admin4@test.local',
      password: 'correct-password-1',
      role: ROLES.ADMIN,
    });

    const agent = request.agent(app);
    await loginAs(agent, 'admin4@test.local', 'correct-password-1');

    const res = await agent.post('/api/admin/users').send({
      name: 'Dispatcher With Fake Provider',
      email: 'fakeprovider@test.local',
      password: 'password-123',
      role: 'dispatcher',
      providerId: 999999,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).not.toMatch(/CONSTRAINT|SQL|fk_/i);
  });
});
