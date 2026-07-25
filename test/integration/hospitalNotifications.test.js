require('../helpers/loadTestEnv');
const request = require('supertest');
const resetDb = require('../helpers/resetDb');
const pool = require('../../src/config/db');
const sessionStore = require('../../src/config/sessionStore');
const createApp = require('../../src/app');
const userService = require('../../src/services/userService');
const { ROLES } = require('../../src/config/roles');

const app = createApp();

const INCIDENT_LOCATION = { lat: -8.9094, lng: 33.4607 };
const AMBULANCE_LOCATION = { lat: -8.912, lng: 33.463 };
const HOSPITAL_LOCATION = { lat: -8.902, lng: 33.452 };

async function setupToOnScene() {
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
  const crewUser = await userService.createUser({
    name: 'Crew',
    email: 'crew@test.local',
    password: 'password-123',
    role: ROLES.CREW,
    providerId,
  });

  const [hospitalResult] = await pool.query(
    `INSERT INTO hospitals (name, location, address) VALUES ('Test Hospital', ST_SRID(POINT(:lat, :lng), 4326), 'Mbeya')`,
    HOSPITAL_LOCATION
  );
  const hospitalId = hospitalResult.insertId;

  const hospitalStaff = await userService.createUser({
    name: 'Hospital Staff',
    email: 'hospitalstaff@test.local',
    password: 'password-123',
    role: ROLES.HOSPITAL_STAFF,
    hospitalId,
  });

  const [ambulanceResult] = await pool.query(
    `INSERT INTO ambulances (provider_id, call_sign, capability_level, status, current_location, last_ping_at, current_crew_user_id)
     VALUES (:providerId, 'MB-01', 'ALS', 'available', ST_SRID(POINT(:lat, :lng), 4326), NOW(), :crewId)`,
    { providerId, ...AMBULANCE_LOCATION, crewId: crewUser.id }
  );
  const ambulanceId = ambulanceResult.insertId;

  const dispatcherAgent = request.agent(app);
  await dispatcherAgent.post('/api/auth/login').send({ email: 'dispatcher@test.local', password: 'password-123' });

  const crewAgent = request.agent(app);
  await crewAgent.post('/api/auth/login').send({ email: 'crew@test.local', password: 'password-123' });

  const hospitalAgent = request.agent(app);
  await hospitalAgent
    .post('/api/auth/login')
    .send({ email: 'hospitalstaff@test.local', password: 'password-123' });

  const incidentRes = await dispatcherAgent.post('/api/incidents').send({
    lat: INCIDENT_LOCATION.lat,
    lng: INCIDENT_LOCATION.lng,
    chiefComplaint: 'cardiac',
    patientNotes: 'Chest pain, diaphoretic',
  });
  const incidentId = incidentRes.body.incident.id;

  await dispatcherAgent.post(`/api/incidents/${incidentId}/assign`).send({ ambulanceId });
  await crewAgent.post(`/api/incidents/${incidentId}/status`).send({ status: 'en_route' });
  await crewAgent.post(`/api/incidents/${incidentId}/status`).send({ status: 'on_scene' });

  return { dispatcherAgent, crewAgent, hospitalAgent, incidentId, hospitalId, ambulanceId, hospitalStaff };
}

describe('hospital pre-notification (integration)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  it('requires a hospitalId when starting transport', async () => {
    const { crewAgent, incidentId } = await setupToOnScene();
    const res = await crewAgent.post(`/api/incidents/${incidentId}/status`).send({ status: 'transporting' });
    expect(res.status).toBe(400);
  });

  it('sends a pre-notification with a real OSRM ETA when transport starts, visible to the hospital', async () => {
    const { crewAgent, hospitalAgent, incidentId, hospitalId } = await setupToOnScene();

    const res = await crewAgent
      .post(`/api/incidents/${incidentId}/status`)
      .send({ status: 'transporting', hospitalId });
    expect(res.status).toBe(200);
    expect(res.body.incident.assigned_hospital_id).toBe(hospitalId);

    const listRes = await hospitalAgent.get('/api/hospital/notifications');
    expect(listRes.status).toBe(200);
    expect(listRes.body.notifications).toHaveLength(1);
    const notification = listRes.body.notifications[0];
    expect(notification.incident_id).toBe(incidentId);
    expect(notification.eta_snapshot_seconds).toBeGreaterThan(0);
    expect(notification.patient_notes).toBe('Chest pain, diaphoretic'); // hospital sees condition detail
    expect(notification.acknowledged_at).toBeNull();

    const [events] = await pool.query(
      "SELECT event_type FROM incident_events WHERE incident_id = ? AND event_type = 'hospital_notified'",
      [incidentId]
    );
    expect(events).toHaveLength(1);
  });

  it('lets hospital staff acknowledge a notification, and rejects a second acknowledgment', async () => {
    const { crewAgent, hospitalAgent, incidentId, hospitalId } = await setupToOnScene();
    await crewAgent.post(`/api/incidents/${incidentId}/status`).send({ status: 'transporting', hospitalId });

    const { notifications } = (await hospitalAgent.get('/api/hospital/notifications')).body;
    const notificationId = notifications[0].id;

    const ackRes = await hospitalAgent.post(`/api/hospital/notifications/${notificationId}/acknowledge`);
    expect(ackRes.status).toBe(200);
    expect(ackRes.body.notification.acknowledged_at).not.toBeNull();

    const secondAck = await hospitalAgent.post(`/api/hospital/notifications/${notificationId}/acknowledge`);
    expect(secondAck.status).toBe(409);

    const [events] = await pool.query(
      "SELECT event_type FROM incident_events WHERE incident_id = ? AND event_type = 'hospital_acknowledged'",
      [incidentId]
    );
    expect(events).toHaveLength(1);
  });

  it('does not let staff from a different hospital see or acknowledge another hospital notification', async () => {
    const { crewAgent, incidentId, hospitalId } = await setupToOnScene();
    await crewAgent.post(`/api/incidents/${incidentId}/status`).send({ status: 'transporting', hospitalId });

    const [otherHospitalResult] = await pool.query(
      `INSERT INTO hospitals (name, location, address) VALUES ('Other Hospital', ST_SRID(POINT(-8.95, 33.5), 4326), 'Elsewhere')`
    );
    await userService.createUser({
      name: 'Other Hospital Staff',
      email: 'otherhospitalstaff@test.local',
      password: 'password-123',
      role: ROLES.HOSPITAL_STAFF,
      hospitalId: otherHospitalResult.insertId,
    });
    const otherAgent = request.agent(app);
    await otherAgent
      .post('/api/auth/login')
      .send({ email: 'otherhospitalstaff@test.local', password: 'password-123' });

    const listRes = await otherAgent.get('/api/hospital/notifications');
    expect(listRes.body.notifications).toHaveLength(0);

    const [[notificationRow]] = await pool.query('SELECT id FROM hospital_notifications LIMIT 1');
    const ackRes = await otherAgent.post(`/api/hospital/notifications/${notificationRow.id}/acknowledge`);
    expect(ackRes.status).toBe(409);
  });

  it('blocks dispatcher and crew roles from the hospital notification endpoints (RBAC)', async () => {
    const { dispatcherAgent, crewAgent } = await setupToOnScene();
    expect((await dispatcherAgent.get('/api/hospital/notifications')).status).toBe(403);
    expect((await crewAgent.get('/api/hospital/notifications')).status).toBe(403);
  });
});
