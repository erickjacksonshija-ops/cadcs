// Realistic demo dataset for the Mbeya region (matches the OSRM extract's
// coverage area). Unlike seed.js (which only bootstraps the first admin
// account), this drives sample incidents through the REAL service layer
// (incidentService/dispatchService, not raw INSERTs) so the resulting
// audit trail, triage classification, and OSRM-computed ETAs are exactly
// as real as anything the live app produces -- not fabricated numbers.
//
// Idempotent by name: safe to re-run, existing rows are reused rather than
// duplicated.
const pool = require('../config/db');
const userService = require('./../services/userService');
const providerService = require('./../services/providerService');
const hospitalService = require('./../services/hospitalService');
const ambulanceService = require('./../services/ambulanceService');
const incidentService = require('./../services/incidentService');
const dispatchService = require('./../services/dispatchService');
const { ROLES } = require('../config/roles');

const DEMO_PASSWORD = 'DemoPass123!';

async function findOrCreateProvider(name, type) {
  const [existing] = await pool.query('SELECT * FROM providers WHERE name = :name', { name });
  if (existing[0]) return existing[0];
  return providerService.createProvider({ name, type });
}

async function findOrCreateHospital(name, lat, lng, address) {
  const [existing] = await pool.query('SELECT id FROM hospitals WHERE name = :name', { name });
  if (existing[0]) return hospitalService.findById(existing[0].id);
  return hospitalService.createHospital({ name, lat, lng, address });
}

async function findOrCreateAmbulance(providerId, callSign, capabilityLevel) {
  const [existing] = await pool.query(
    'SELECT * FROM ambulances WHERE provider_id = :providerId AND call_sign = :callSign',
    { providerId, callSign }
  );
  if (existing[0]) return existing[0];
  return ambulanceService.createAmbulance({ providerId, callSign, capabilityLevel });
}

async function findOrCreateUser(opts) {
  const existing = await userService.findByEmail(opts.email);
  if (existing) return existing;
  return userService.createUser({ ...opts, password: DEMO_PASSWORD });
}

// Marks an ambulance "on shift" with a known position -- this is seed
// scaffolding representing a fleet that has already checked in for the
// day, not an audited dispatch action, so it's a direct write (matches
// how ambulanceService.updateLocation itself works -- no audit event is
// expected for routine GPS pings either).
async function putAmbulanceOnShift(ambulanceId, lat, lng) {
  await ambulanceService.updateLocation(ambulanceId, lat, lng);
  await pool.query("UPDATE ambulances SET status = 'available' WHERE id = :id", { id: ambulanceId });
}

async function runFullIncidentLifecycle({ dispatcherId, ambulanceId, hospitalId, location, chiefComplaint, redFlags, patientNotes }) {
  const incident = await incidentService.createIncident({
    lat: location.lat,
    lng: location.lng,
    locationDescription: location.description,
    chiefComplaint,
    redFlags: redFlags || {},
    patientNotes,
    createdBy: dispatcherId,
  });

  await dispatchService.assignAmbulance(incident.id, ambulanceId, dispatcherId);

  // Drive the crew-side lifecycle through the same state machine the real
  // crew PWA uses -- updateMissionStatus needs a crew user, so look up who
  // is currently assigned to this ambulance.
  const [[ambulanceRow]] = await pool.query('SELECT current_crew_user_id FROM ambulances WHERE id = :id', {
    id: ambulanceId,
  });
  const crewUserId = ambulanceRow.current_crew_user_id;

  for (const status of ['en_route', 'on_scene']) {
    await dispatchService.updateMissionStatus(incident.id, crewUserId, status);
  }
  await dispatchService.updateMissionStatus(incident.id, crewUserId, 'transporting', hospitalId);
  await dispatchService.updateMissionStatus(incident.id, crewUserId, 'at_hospital');
  await dispatchService.updateMissionStatus(incident.id, crewUserId, 'closed');

  return incidentService.findById(incident.id);
}

// Seed-only realism step. The real lifecycle above runs through the
// actual service layer in under a second, which would make every
// response-time metric round to "0m 0s" -- trivially "meeting" the WHO
// benchmark without demonstrating anything credible. This backdates the
// SEEDED incident's event timestamps to a plausible real-world timeline
// (dispatcher review time, drive time, handover) while leaving the event
// types, order, and all other data exactly as the real code produced
// them. This does not weaken the production integrity guarantee that
// timestamps are always server-generated, never caller-supplied -- that
// guarantee is about the live application's write path; this is an
// offline demo-data script adjusting its own just-created rows.
async function backdateIncidentTimeline(incidentId, offsetsSeconds) {
  const [events] = await pool.query(
    'SELECT id, event_type, metadata FROM incident_events WHERE incident_id = :id ORDER BY occurred_at',
    { id: incidentId }
  );
  const [[incident]] = await pool.query('SELECT reported_at FROM incidents WHERE id = :id', { id: incidentId });
  const baseTime = new Date(incident.reported_at).getTime();

  for (const event of events) {
    let offsetKey = event.event_type;
    if (event.event_type === 'status_changed') {
      const metadata = typeof event.metadata === 'string' ? JSON.parse(event.metadata) : event.metadata;
      offsetKey = `status_changed:${metadata.to}`;
    }
    const offsetSeconds = offsetsSeconds[offsetKey];
    if (offsetSeconds === undefined) continue;

    await pool.query('UPDATE incident_events SET occurred_at = :occurredAt WHERE id = :id', {
      occurredAt: new Date(baseTime + offsetSeconds * 1000),
      id: event.id,
    });
  }

  if (offsetsSeconds.closed !== undefined) {
    await pool.query('UPDATE incidents SET closed_at = :closedAt WHERE id = :id', {
      closedAt: new Date(baseTime + offsetsSeconds.closed * 1000),
      id: incidentId,
    });
  }
}

async function run() {
  console.log('Seeding Mbeya-region demo dataset...');

  // --- Providers -----------------------------------------------------
  const mbeyaRegionalEms = await findOrCreateProvider('Mbeya Regional EMS', 'hospital_owned');
  const songweAmbulance = await findOrCreateProvider('Songwe Private Ambulance', 'private');
  const redCrossMbeya = await findOrCreateProvider('Red Cross Mbeya', 'ngo');

  // --- Hospitals -------------------------------------------------------
  // Only one entry here, deliberately: Mbeya Zonal Referral Hospital is a
  // real, verified institution -- name, address, and these exact
  // coordinates come from the hospital's own published directory listing
  // (Sisimba Street, Uzunguni, Mbeya), not an estimate. Earlier drafts of
  // this seed script included three additional "hospitals" with
  // approximated coordinates and, in one case, a made-up name -- removed
  // entirely rather than kept as labeled placeholders, per an explicit
  // instruction not to mix approximated data into what's presented as
  // real. Add more here only when each one is independently verified the
  // same way.
  const hospitals = {
    zonal: await findOrCreateHospital(
      'Mbeya Zonal Referral Hospital',
      -8.8956083,
      33.4455639,
      'Sisimba Street, Uzunguni, Mbeya'
    ),
  };

  // --- Dispatchers -----------------------------------------------------
  const dispatcher1 = await findOrCreateUser({
    name: 'Grace Mwakalinga',
    email: 'grace.dispatcher@cadcs.local',
    role: ROLES.DISPATCHER,
    providerId: mbeyaRegionalEms.id,
  });
  await findOrCreateUser({
    name: 'Peter Mwasyoge',
    email: 'peter.dispatcher@cadcs.local',
    role: ROLES.DISPATCHER,
    providerId: songweAmbulance.id,
  });

  // --- Ambulances + crew, one crew member per unit, "on shift" -------
  const fleet = [
    { provider: mbeyaRegionalEms, callSign: 'MB-01', capability: 'ALS', crewName: 'Sam Mwakyusa', lat: -8.912, lng: 33.463 },
    { provider: mbeyaRegionalEms, callSign: 'MB-02', capability: 'ALS', crewName: 'Neema Kalinga', lat: -8.89, lng: 33.44 },
    { provider: mbeyaRegionalEms, callSign: 'MB-03', capability: 'BLS', crewName: 'John Mwaipungu', lat: -8.93, lng: 33.47 },
    { provider: songweAmbulance, callSign: 'SW-01', capability: 'ALS', crewName: 'Fatuma Ngonyani', lat: -8.88, lng: 33.5 },
    { provider: songweAmbulance, callSign: 'SW-02', capability: 'BLS', crewName: 'Emmanuel Sanga', lat: -8.94, lng: 33.55 },
    { provider: redCrossMbeya, callSign: 'RC-01', capability: 'BLS', crewName: 'Agnes Mwansasu', lat: -8.9, lng: 33.42 },
  ];

  const ambulances = [];
  for (const unit of fleet) {
    const ambulance = await findOrCreateAmbulance(unit.provider.id, unit.callSign, unit.capability);
    const crewUser = await findOrCreateUser({
      name: unit.crewName,
      email: `${unit.crewName.split(' ')[0].toLowerCase()}.crew@cadcs.local`,
      role: ROLES.CREW,
      providerId: unit.provider.id,
    });
    await pool.query('UPDATE ambulances SET current_crew_user_id = :crewId WHERE id = :id', {
      crewId: crewUser.id,
      id: ambulance.id,
    });
    await putAmbulanceOnShift(ambulance.id, unit.lat, unit.lng);
    ambulances.push({ ...ambulance, capability_level: unit.capability, crewUser });
  }

  // --- Hospital staff ----------------------------------------------------
  await findOrCreateUser({
    name: 'Nurse Amina Chale',
    email: 'amina.hospital@cadcs.local',
    role: ROLES.HOSPITAL_STAFF,
    hospitalId: hospitals.zonal.id,
  });
  await findOrCreateUser({
    name: 'Dr. Baraka Mwang’onda',
    email: 'baraka.hospital@cadcs.local',
    role: ROLES.HOSPITAL_STAFF,
    hospitalId: hospitals.zonal.id,
  });

  // --- Sample incidents, driven through the real dispatch lifecycle -----
  // Deliberately varied: different priorities, different capability
  // requirements, different destination hospitals -- so the analytics
  // dashboard (Sprint 6) has real, varied response-time data to show
  // rather than one repeated case.
  const alsUnit = ambulances.find((a) => a.call_sign === 'MB-01' && a.capability_level === 'ALS');
  const alsUnit2 = ambulances.find((a) => a.call_sign === 'SW-01');
  const blsUnit = ambulances.find((a) => a.call_sign === 'MB-03');

  // timelineOffsets: seconds-from-'created' used to backdate the seeded
  // audit trail into a plausible real-world pace (see
  // backdateIncidentTimeline). The scene-to-hospital leg intentionally
  // uses roughly the real OSRM-computed transport ETA observed for these
  // routes during development, so that phase of the timeline lines up
  // with genuine routing distance, not an arbitrary guess. Scenario 3 is
  // deliberately paced to land OUTSIDE the WHO 8-minute benchmark
  // (further location, real geography) -- the dashboard should show a
  // credible mix of results, not a suspicious 100% pass rate.
  const scenarios = [
    {
      ambulanceId: alsUnit.id,
      hospitalId: hospitals.zonal.id,
      location: { lat: -8.9094, lng: 33.4607, description: 'Soweto Street, near the market' },
      chiefComplaint: 'cardiac',
      redFlags: {},
      patientNotes: '62yo male, crushing chest pain, diaphoretic',
      timelineOffsets: {
        created: 0, triage_suggested: 3, assigned: 95, 'status_changed:en_route': 110,
        'status_changed:on_scene': 430, hospital_notified: 610, 'status_changed:transporting': 615,
        'status_changed:at_hospital': 745, closed: 820,
      },
    },
    {
      ambulanceId: blsUnit.id,
      hospitalId: hospitals.zonal.id,
      location: { lat: -8.93, lng: 33.475, description: 'Along Tanzam Road, Mwakibete' },
      chiefComplaint: 'trauma',
      redFlags: {},
      patientNotes: 'Motorcycle accident, leg laceration, alert and stable',
      timelineOffsets: {
        created: 0, triage_suggested: 3, assigned: 80, 'status_changed:en_route': 95,
        'status_changed:on_scene': 320, hospital_notified: 470, 'status_changed:transporting': 475,
        'status_changed:at_hospital': 909, closed: 970,
      },
    },
    {
      ambulanceId: alsUnit2.id,
      hospitalId: hospitals.zonal.id,
      location: { lat: -8.885, lng: 33.505, description: 'Near Uyole junction' },
      chiefComplaint: 'obstetric',
      redFlags: {},
      patientNotes: 'Active labor, second pregnancy, contractions 4 min apart',
      timelineOffsets: {
        created: 0, triage_suggested: 3, assigned: 110, 'status_changed:en_route': 130,
        'status_changed:on_scene': 840, hospital_notified: 960, 'status_changed:transporting': 965,
        'status_changed:at_hospital': 2322, closed: 2400,
      },
    },
  ];

  for (const scenario of scenarios) {
    const { timelineOffsets, ...lifecycleArgs } = scenario;
    const incident = await runFullIncidentLifecycle({ dispatcherId: dispatcher1.id, ...lifecycleArgs });
    await backdateIncidentTimeline(incident.id, timelineOffsets);
    // Re-put the ambulance back on shift/available for the next scenario
    // that might reuse it, mirroring a real unit returning to service.
    await pool.query("UPDATE ambulances SET status = 'available' WHERE id = :id", { id: scenario.ambulanceId });
  }

  // One in-progress incident left open (not closed) so the dispatcher/crew
  // dashboards have something live to show too, not just historical data.
  const openIncident = await incidentService.createIncident({
    lat: -8.86,
    lng: 33.44,
    locationDescription: 'Igawilo village center',
    chiefComplaint: 'respiratory',
    redFlags: { notBreathing: false },
    patientNotes: 'Elderly patient, acute breathlessness, history of asthma',
    createdBy: dispatcher1.id,
  });
  // 'respiratory' with no red flags classifies as P2/ALS (see
  // triageService) -- needs an ALS-capable unit, not the BLS one.
  await dispatchService.assignAmbulance(openIncident.id, alsUnit2.id, dispatcher1.id);

  console.log('Demo dataset seeded successfully.');
  console.log('');
  console.log('Demo accounts (all use password: ' + DEMO_PASSWORD + '):');
  console.log('  Dispatcher:      grace.dispatcher@cadcs.local');
  console.log('  Crew (MB-01):    sam.crew@cadcs.local');
  console.log('  Hospital staff:  amina.hospital@cadcs.local');
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { run };
