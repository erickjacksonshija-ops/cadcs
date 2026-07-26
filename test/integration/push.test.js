require('../helpers/loadTestEnv');
const request = require('supertest');
const resetDb = require('../helpers/resetDb');
const pool = require('../../src/config/db');
const sessionStore = require('../../src/config/sessionStore');
const createApp = require('../../src/app');
const userService = require('../../src/services/userService');
const { ROLES } = require('../../src/config/roles');

const app = createApp();

const SAMPLE_SUBSCRIPTION = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint-1',
  keys: { p256dh: 'test-p256dh-key', auth: 'test-auth-key' },
};

async function dispatcherAgent() {
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
  return agent;
}

describe('web push subscriptions (integration)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  it('reports the VAPID public key as configured (real key pair is set in .env.test)', async () => {
    const agent = await dispatcherAgent();
    const res = await agent.get('/api/push/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.publicKey).toBeTruthy();
  });

  it('subscribes, persists the row, and unsubscribing removes it', async () => {
    const agent = await dispatcherAgent();

    const subRes = await agent.post('/api/push/subscribe').send(SAMPLE_SUBSCRIPTION);
    expect(subRes.status).toBe(201);

    const [[row]] = await pool.query('SELECT * FROM push_subscriptions WHERE endpoint = :endpoint', {
      endpoint: SAMPLE_SUBSCRIPTION.endpoint,
    });
    expect(row).toBeDefined();
    expect(row.p256dh_key).toBe('test-p256dh-key');

    const unsubRes = await agent.post('/api/push/unsubscribe').send({ endpoint: SAMPLE_SUBSCRIPTION.endpoint });
    expect(unsubRes.status).toBe(200);

    const [rowsAfter] = await pool.query('SELECT * FROM push_subscriptions WHERE endpoint = :endpoint', {
      endpoint: SAMPLE_SUBSCRIPTION.endpoint,
    });
    expect(rowsAfter).toHaveLength(0);
  });

  it('re-subscribing the same endpoint updates rather than duplicates', async () => {
    const agent = await dispatcherAgent();
    await agent.post('/api/push/subscribe').send(SAMPLE_SUBSCRIPTION);
    await agent.post('/api/push/subscribe').send({
      ...SAMPLE_SUBSCRIPTION,
      keys: { p256dh: 'updated-key', auth: 'updated-auth' },
    });

    const [rows] = await pool.query('SELECT * FROM push_subscriptions WHERE endpoint = :endpoint', {
      endpoint: SAMPLE_SUBSCRIPTION.endpoint,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].p256dh_key).toBe('updated-key');
  });

  it('rejects a malformed subscription payload', async () => {
    const agent = await dispatcherAgent();
    const res = await agent.post('/api/push/subscribe').send({ endpoint: 'https://example.com/x' });
    expect(res.status).toBe(400);
  });

  it('blocks crew from subscribing to push (dispatcher/hospital/admin only)', async () => {
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

    const res = await agent.post('/api/push/subscribe').send(SAMPLE_SUBSCRIPTION);
    expect(res.status).toBe(403);
  });

  it('blocks unauthenticated requests', async () => {
    const res = await request(app).post('/api/push/subscribe').send(SAMPLE_SUBSCRIPTION);
    expect(res.status).toBe(401);
  });
});
