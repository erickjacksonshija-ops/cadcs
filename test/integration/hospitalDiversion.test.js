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
// One noticeably closer than the other, so "accepting sorts first despite
// being farther" is an actual, verifiable claim, not a coincidence of order.
const NEAR_HOSPITAL_LOCATION = { lat: -8.905, lng: 33.462 };
const FAR_HOSPITAL_LOCATION = { lat: -8.95, lng: 33.5 };

async function setupOnScene() {
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

  const [nearHospitalResult] = await pool.query(
    `INSERT INTO hospitals (name, location, address) VALUES ('Near Hospital', ST_SRID(POINT(:lat, :lng), 4326), 'Mbeya')`,
    NEAR_HOSPITAL_LOCATION
  );
  const [farHospitalResult] = await pool.query(
    `INSERT INTO hospitals (name, location, address) VALUES ('Far Hospital', ST_SRID(POINT(:lat, :lng), 4326), 'Mbeya')`,
    FAR_HOSPITAL_LOCATION
  );
  const nearHospitalId = nearHospitalResult.insertId;
  const farHospitalId = farHospitalResult.insertId;

  const nearHospitalStaff = await userService.createUser({
    name: 'Near Hospital Staff',
    email: 'nearstaff@test.local',
    password: 'password-123',
    role: ROLES.HOSPITAL_STAFF,
    hospitalId: nearHospitalId,
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

  const nearHospitalAgent = request.agent(app);
  await nearHospitalAgent.post('/api/auth/login').send({ email: 'nearstaff@test.local', password: 'password-123' });

  const incidentRes = await dispatcherAgent.post('/api/incidents').send({
    lat: INCIDENT_LOCATION.lat,
    lng: INCIDENT_LOCATION.lng,
    chiefComplaint: 'trauma',
  });
  const incidentId = incidentRes.body.incident.id;
  await dispatcherAgent.post(`/api/incidents/${incidentId}/assign`).send({ ambulanceId });
  await crewAgent.post(`/api/incidents/${incidentId}/status`).send({ status: 'en_route' });
  await crewAgent.post(`/api/incidents/${incidentId}/status`).send({ status: 'on_scene' });

  return { dispatcherAgent, crewAgent, nearHospitalAgent, incidentId, nearHospitalId, farHospitalId };
}

describe('hospital diversion status (integration)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await new Promise((resolve) => sessionStore.close(resolve));
    await pool.end();
  });

  it('defaults a hospital to accepting, and lets its own staff toggle it to diversion with a reason', async () => {
    const { nearHospitalAgent } = await setupOnScene();

    const initial = await nearHospitalAgent.get('/api/hospitals/mine');
    expect(initial.status).toBe(200);
    expect(initial.body.hospital.diversion_status).toBe('accepting');

    const diversionRes = await nearHospitalAgent
      .post('/api/hospitals/mine/diversion-status')
      .send({ status: 'diversion', reason: 'ED at capacity' });
    expect(diversionRes.status).toBe(200);
    expect(diversionRes.body.hospital.diversion_status).toBe('diversion');
    expect(diversionRes.body.hospital.diversion_reason).toBe('ED at capacity');

    const acceptingAgainRes = await nearHospitalAgent
      .post('/api/hospitals/mine/diversion-status')
      .send({ status: 'accepting' });
    expect(acceptingAgainRes.status).toBe(200);
    expect(acceptingAgainRes.body.hospital.diversion_status).toBe('accepting');
  });

  it('rejects an invalid diversion status value', async () => {
    const { nearHospitalAgent } = await setupOnScene();
    const res = await nearHospitalAgent.post('/api/hospitals/mine/diversion-status').send({ status: 'closed-forever' });
    expect(res.status).toBe(400);
  });

  it("sorts a diverting hospital after accepting ones in the crew's ranked picker, even when it's closer", async () => {
    const { crewAgent, nearHospitalAgent, incidentId, nearHospitalId, farHospitalId } = await setupOnScene();

    const before = await crewAgent.get(`/api/incidents/${incidentId}/hospitals`);
    expect(before.status).toBe(200);
    expect(before.body.hospitals[0].hospitalId).toBe(nearHospitalId); // closer one ranks first normally

    await nearHospitalAgent.post('/api/hospitals/mine/diversion-status').send({ status: 'diversion', reason: 'full' });

    const after = await crewAgent.get(`/api/incidents/${incidentId}/hospitals`);
    expect(after.status).toBe(200);
    const hospitalIds = after.body.hospitals.map((h) => h.hospitalId);
    // Still present -- diversion is advisory, never removed from the list.
    expect(hospitalIds).toContain(nearHospitalId);
    expect(hospitalIds).toContain(farHospitalId);
    // But no longer ranked first, despite being physically closer.
    expect(after.body.hospitals[0].hospitalId).toBe(farHospitalId);
    expect(after.body.hospitals.find((h) => h.hospitalId === nearHospitalId).diversionStatus).toBe('diversion');
  });

  it('blocks a dispatcher from setting another hospital\'s diversion status (scoped to session hospitalId)', async () => {
    const { dispatcherAgent } = await setupOnScene();
    const res = await dispatcherAgent.post('/api/hospitals/mine/diversion-status').send({ status: 'diversion' });
    expect(res.status).toBe(403);
  });
});
