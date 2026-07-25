require('../helpers/loadTestEnv');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
const resetDb = require('../helpers/resetDb');
const pool = require('../../src/config/db');
const sessionStore = require('../../src/config/sessionStore');
const createServer = require('../../src/createServer');
const userService = require('../../src/services/userService');
const { ROLES } = require('../../src/config/roles');

let server;
let app;
let baseUrl;

function sessionCookieFrom(res) {
  const setCookieHeader = res.headers['set-cookie'];
  const sidCookie = setCookieHeader.find((c) => c.startsWith('connect.sid='));
  return sidCookie.split(';')[0]; // "connect.sid=s%3A...."
}

function connectClient(cookie) {
  return ioClient(baseUrl, {
    extraHeaders: cookie ? { cookie } : {},
    transports: ['websocket'],
    reconnection: false,
  });
}

function waitForEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for '${event}'`)), timeoutMs);
    socket.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args[0]);
    });
  });
}

describe('Socket.IO real-time layer (integration)', () => {
  beforeAll((done) => {
    ({ app, server } = createServer());
    server.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      done();
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  beforeEach(async () => {
    await resetDb();
  });

  it('rejects a socket connection with no session cookie', async () => {
    const client = connectClient(null);
    const err = await waitForEvent(client, 'connect_error');
    expect(err.message).toBe('unauthorized');
    client.close();
  });

  it('authenticates a dispatcher socket off the session cookie and joins the dispatchers room', async () => {
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

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'dispatcher@test.local', password: 'password-123' });
    const cookie = sessionCookieFrom(loginRes);

    const client = connectClient(cookie);
    await waitForEvent(client, 'connect');
    expect(client.connected).toBe(true);
    client.close();
  });

  it('broadcasts a crew GPS ping to the dispatchers room and updates the DB', async () => {
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
      `INSERT INTO ambulances (provider_id, call_sign, capability_level, status, current_crew_user_id)
       VALUES (:providerId, 'MB-01', 'ALS', 'dispatched', :crewUserId)`,
      { providerId, crewUserId: crewUser.id }
    );
    const ambulanceId = ambulanceResult.insertId;

    const dispatcherLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'dispatcher@test.local', password: 'password-123' });
    const dispatcherCookie = sessionCookieFrom(dispatcherLogin);

    const crewLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'crew@test.local', password: 'password-123' });
    const crewCookie = sessionCookieFrom(crewLogin);

    const dispatcherSocket = connectClient(dispatcherCookie);
    await waitForEvent(dispatcherSocket, 'connect');

    const crewSocket = connectClient(crewCookie);
    await waitForEvent(crewSocket, 'connect');

    const broadcastPromise = waitForEvent(dispatcherSocket, 'ambulance:location');
    crewSocket.emit('ambulance:location', { lat: -8.9094, lng: 33.4607 });

    const payload = await broadcastPromise;
    expect(payload.ambulanceId).toBe(ambulanceId);
    expect(payload.lat).toBeCloseTo(-8.9094, 4);
    expect(payload.lng).toBeCloseTo(33.4607, 4);

    const [rows] = await pool.query('SELECT last_ping_at FROM ambulances WHERE id = ?', [ambulanceId]);
    expect(rows[0].last_ping_at).not.toBeNull();

    dispatcherSocket.close();
    crewSocket.close();
    expect(dispatcher).toBeTruthy(); // keep var referenced/used
  });

  it('does not broadcast a GPS ping from a crew socket with no assigned ambulance', async () => {
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
    await userService.createUser({
      name: 'Unassigned Crew',
      email: 'unassignedcrew@test.local',
      password: 'password-123',
      role: ROLES.CREW,
      providerId: providerResult.insertId,
    });

    const dispatcherLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'dispatcher@test.local', password: 'password-123' });
    const dispatcherSocket = connectClient(sessionCookieFrom(dispatcherLogin));
    await waitForEvent(dispatcherSocket, 'connect');

    const crewLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'unassignedcrew@test.local', password: 'password-123' });
    const crewSocket = connectClient(sessionCookieFrom(crewLogin));
    await waitForEvent(crewSocket, 'connect');

    let received = false;
    dispatcherSocket.once('ambulance:location', () => {
      received = true;
    });
    crewSocket.emit('ambulance:location', { lat: -8.9, lng: 33.45 });

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(received).toBe(false);

    dispatcherSocket.close();
    crewSocket.close();
  });

  it('broadcasts a newly created incident to all dispatcher sockets, not just the creator', async () => {
    const [providerResult] = await pool.query(
      "INSERT INTO providers (name, type) VALUES ('Test Provider', 'private')"
    );
    await userService.createUser({
      name: 'Dispatcher One',
      email: 'dispatcher1@test.local',
      password: 'password-123',
      role: ROLES.DISPATCHER,
      providerId: providerResult.insertId,
    });
    await userService.createUser({
      name: 'Dispatcher Two',
      email: 'dispatcher2@test.local',
      password: 'password-123',
      role: ROLES.DISPATCHER,
      providerId: providerResult.insertId,
    });

    const agent1 = request.agent(app);
    await agent1.post('/api/auth/login').send({ email: 'dispatcher1@test.local', password: 'password-123' });

    const login2 = await request(app)
      .post('/api/auth/login')
      .send({ email: 'dispatcher2@test.local', password: 'password-123' });
    const socket2 = connectClient(sessionCookieFrom(login2));
    await waitForEvent(socket2, 'connect');

    const broadcastPromise = waitForEvent(socket2, 'incident:created');

    // Dispatcher one creates the incident over the REST API (not socket1
    // itself), then dispatcher two's socket should see it pushed live.
    await agent1.post('/api/incidents').send({
      lat: -8.9094,
      lng: 33.4607,
      chiefComplaint: 'trauma',
    });

    const incident = await broadcastPromise;
    expect(incident.chief_complaint).toBe('trauma');
    expect(incident.status).toBe('reported');

    socket2.close();
  });
});
