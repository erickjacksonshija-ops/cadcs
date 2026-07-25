require('../helpers/loadTestEnv');
const request = require('supertest');
const resetDb = require('../helpers/resetDb');
const pool = require('../../src/config/db');
const sessionStore = require('../../src/config/sessionStore');
const createApp = require('../../src/app');
const userService = require('../../src/services/userService');
const { ROLES } = require('../../src/config/roles');

const app = createApp();

async function adminAgent() {
  await userService.createUser({
    name: 'Admin',
    email: 'admin@test.local',
    password: 'correct-password-1',
    role: ROLES.ADMIN,
  });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email: 'admin@test.local', password: 'correct-password-1' });
  return agent;
}

describe('admin resource provisioning (integration)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  it('creates a provider and lists it', async () => {
    const agent = await adminAgent();

    const createRes = await agent
      .post('/api/admin/providers')
      .send({ name: 'Mbeya EMS Co-op', type: 'private' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.provider.name).toBe('Mbeya EMS Co-op');

    const listRes = await agent.get('/api/admin/providers');
    expect(listRes.status).toBe(200);
    expect(listRes.body.providers).toHaveLength(1);
  });

  it('creates a hospital with a real lat/lng and reads it back correctly', async () => {
    const agent = await adminAgent();

    // Mbeya Zonal Referral Hospital, approx coordinates
    const createRes = await agent.post('/api/admin/hospitals').send({
      name: 'Mbeya Zonal Referral Hospital',
      lat: -8.9094,
      lng: 33.4607,
      address: 'Mbeya',
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body.hospital.lat).toBeCloseTo(-8.9094, 4);
    expect(createRes.body.hospital.lng).toBeCloseTo(33.4607, 4);
  });

  it('rejects an out-of-range latitude', async () => {
    const agent = await adminAgent();
    const res = await agent.post('/api/admin/hospitals').send({
      name: 'Invalid Hospital',
      lat: 999,
      lng: 33.4607,
    });
    expect(res.status).toBe(400);
  });

  it('creates an ambulance tied to a provider, with no location until a ping arrives', async () => {
    const agent = await adminAgent();
    const providerRes = await agent
      .post('/api/admin/providers')
      .send({ name: 'Provider A', type: 'hospital_owned' });
    const providerId = providerRes.body.provider.id;

    const ambulanceRes = await agent.post('/api/admin/ambulances').send({
      providerId,
      callSign: 'MB-01',
      capabilityLevel: 'ALS',
    });

    expect(ambulanceRes.status).toBe(201);
    expect(ambulanceRes.body.ambulance.status).toBe('out_of_service');
    expect(ambulanceRes.body.ambulance.lat).toBeNull();
  });

  it('rejects a duplicate call sign within the same provider with a clean 409, not a leaked constraint name', async () => {
    const agent = await adminAgent();
    const providerRes = await agent
      .post('/api/admin/providers')
      .send({ name: 'Provider B', type: 'ngo' });
    const providerId = providerRes.body.provider.id;

    await agent.post('/api/admin/ambulances').send({ providerId, callSign: 'MB-01', capabilityLevel: 'BLS' });
    const dupRes = await agent
      .post('/api/admin/ambulances')
      .send({ providerId, callSign: 'MB-01', capabilityLevel: 'BLS' });

    expect(dupRes.status).toBe(409);
    expect(dupRes.body.error).not.toMatch(/CONSTRAINT|uq_/i);
  });

  it('blocks a non-admin from creating a provider (RBAC)', async () => {
    const providerRes = await (await adminAgent()).post('/api/admin/providers').send({
      name: 'Seed Provider',
      type: 'private',
    });
    const providerId = providerRes.body.provider.id;

    await userService.createUser({
      name: 'Dispatcher',
      email: 'dispatcher@test.local',
      password: 'password-123',
      role: ROLES.DISPATCHER,
      providerId,
    });

    const dispatcherAgent = request.agent(app);
    await dispatcherAgent
      .post('/api/auth/login')
      .send({ email: 'dispatcher@test.local', password: 'password-123' });

    const res = await dispatcherAgent.post('/api/admin/providers').send({ name: 'Nope', type: 'private' });
    expect(res.status).toBe(403);
  });

  it('lets an admin reset a user password, and the new password actually works to log in', async () => {
    const agent = await adminAgent();
    const providerRes = await agent.post('/api/admin/providers').send({ name: 'Provider C', type: 'private' });
    const providerId = providerRes.body.provider.id;

    await userService.createUser({
      name: 'Forgetful Dispatcher',
      email: 'forgetful@test.local',
      password: 'original-password-1',
      role: ROLES.DISPATCHER,
      providerId,
    });
    const [[user]] = await pool.query('SELECT id FROM users WHERE email = ?', ['forgetful@test.local']);

    const resetRes = await agent
      .post(`/api/admin/users/${user.id}/reset-password`)
      .send({ newPassword: 'brand-new-password-1' });
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.user.password_hash).toBeUndefined();

    // Old password no longer works.
    const oldLoginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'forgetful@test.local', password: 'original-password-1' });
    expect(oldLoginRes.status).toBe(401);

    // New password does.
    const newLoginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'forgetful@test.local', password: 'brand-new-password-1' });
    expect(newLoginRes.status).toBe(200);
  });

  it('blocks a non-admin from resetting a password (RBAC)', async () => {
    const agent = await adminAgent();
    const providerRes = await agent.post('/api/admin/providers').send({ name: 'Provider D', type: 'private' });
    const providerId = providerRes.body.provider.id;

    await userService.createUser({
      name: 'Dispatcher Target',
      email: 'target@test.local',
      password: 'password-123',
      role: ROLES.DISPATCHER,
      providerId,
    });
    await userService.createUser({
      name: 'Other Dispatcher',
      email: 'otherdispatcher@test.local',
      password: 'password-123',
      role: ROLES.DISPATCHER,
      providerId,
    });
    const [[target]] = await pool.query('SELECT id FROM users WHERE email = ?', ['target@test.local']);

    const otherAgent = request.agent(app);
    await otherAgent
      .post('/api/auth/login')
      .send({ email: 'otherdispatcher@test.local', password: 'password-123' });

    const res = await otherAgent
      .post(`/api/admin/users/${target.id}/reset-password`)
      .send({ newPassword: 'some-new-password-1' });
    expect(res.status).toBe(403);
  });
});
