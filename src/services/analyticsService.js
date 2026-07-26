const pool = require('../config/db');
const env = require('../config/env');

// Response-time breakdowns are computed from incident_events timestamps
// (all server-generated, see auditService) rather than trusted client
// input -- this is the actual evidence for the proposal's Objective v
// ("evaluate the system's functional performance against defined
// response time... benchmarks"), not a claim.

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Monday-anchored ISO-ish week start, formatted as the date itself so bars
// sort and label chronologically without pulling in a date library.
function weekStartKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return d.toISOString().slice(0, 10);
}

function eventTimeMs(events, predicate) {
  const found = events.find(predicate);
  return found ? new Date(found.occurred_at).getTime() : null;
}

function statusChangedTo(targetStatus) {
  return (e) => {
    if (e.event_type !== 'status_changed') return false;
    const metadata = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata;
    return metadata && metadata.to === targetStatus;
  };
}

// Per-incident timing breakdown for every closed incident. WHO's
// response-time benchmark (Sec 1.1 of the proposal) is measured
// call-to-scene, matching how "response time" is conventionally defined
// in EMS literature -- not call-to-hospital-arrival, which is a separate
// transport-time measure.
async function computeIncidentTimings() {
  const [incidents] = await pool.query(
    `SELECT i.id, i.priority, i.chief_complaint, i.reported_at, i.closed_at, a.provider_id
     FROM incidents i
     LEFT JOIN ambulances a ON a.id = i.assigned_ambulance_id
     WHERE i.status = 'closed'`
  );

  const timings = [];
  for (const incident of incidents) {
    const [events] = await pool.query(
      'SELECT event_type, occurred_at, metadata FROM incident_events WHERE incident_id = :id ORDER BY occurred_at',
      { id: incident.id }
    );

    const createdAt = eventTimeMs(events, (e) => e.event_type === 'created');
    const assignedAt = eventTimeMs(events, (e) => e.event_type === 'assigned');
    const onSceneAt = eventTimeMs(events, statusChangedTo('on_scene'));
    const atHospitalAt = eventTimeMs(events, statusChangedTo('at_hospital'));

    timings.push({
      incidentId: incident.id,
      priority: incident.priority,
      chiefComplaint: incident.chief_complaint,
      providerId: incident.provider_id,
      reportedAt: incident.reported_at,
      hourOfDay: new Date(incident.reported_at).getHours(),
      dayOfWeek: DAY_NAMES[new Date(incident.reported_at).getDay()],
      weekStart: weekStartKey(new Date(incident.reported_at)),
      callToDispatchSeconds: assignedAt && createdAt ? (assignedAt - createdAt) / 1000 : null,
      dispatchToSceneSeconds: onSceneAt && assignedAt ? (onSceneAt - assignedAt) / 1000 : null,
      sceneToHospitalSeconds: atHospitalAt && onSceneAt ? (atHospitalAt - onSceneAt) / 1000 : null,
      // The WHO-benchmarked figure: call received -> ambulance on scene.
      callToSceneSeconds: onSceneAt && createdAt ? (onSceneAt - createdAt) / 1000 : null,
    });
  }
  return timings;
}

function summarizeDurations(values) {
  const clean = values.filter((v) => v !== null && v !== undefined);
  return {
    count: clean.length,
    meanSeconds: mean(clean),
    medianSeconds: median(clean),
    p95Seconds: percentile(clean, 95),
  };
}

async function getSummary() {
  const timings = await computeIncidentTimings();
  const callToScene = timings.map((t) => t.callToSceneSeconds).filter((v) => v !== null);

  const withinBenchmark = callToScene.filter((s) => s <= env.responseTimeBenchmarkSeconds).length;

  const volumeByPriority = {};
  const volumeByHour = {};
  const volumeByProvider = {};
  const volumeByDayOfWeekRaw = {};
  const volumeByWeekRaw = {};
  for (const t of timings) {
    volumeByPriority[t.priority] = (volumeByPriority[t.priority] || 0) + 1;
    volumeByHour[t.hourOfDay] = (volumeByHour[t.hourOfDay] || 0) + 1;
    if (t.providerId) volumeByProvider[t.providerId] = (volumeByProvider[t.providerId] || 0) + 1;
    volumeByDayOfWeekRaw[t.dayOfWeek] = (volumeByDayOfWeekRaw[t.dayOfWeek] || 0) + 1;
    volumeByWeekRaw[t.weekStart] = (volumeByWeekRaw[t.weekStart] || 0) + 1;
  }

  // Insertion order controls display order for object-keyed bar charts on
  // the frontend, so these are rebuilt in a deliberate order rather than
  // however the incidents happened to be iterated above.
  const volumeByDayOfWeek = {};
  for (const day of DAY_NAMES.slice(1).concat(DAY_NAMES[0])) {
    if (volumeByDayOfWeekRaw[day]) volumeByDayOfWeek[day] = volumeByDayOfWeekRaw[day];
  }
  const volumeByWeek = {};
  for (const week of Object.keys(volumeByWeekRaw).sort()) {
    volumeByWeek[week] = volumeByWeekRaw[week];
  }

  const [providers] = await pool.query('SELECT id, name FROM providers');
  const providerNames = Object.fromEntries(providers.map((p) => [p.id, p.name]));

  const [pendingAcks] = await pool.query(
    'SELECT COUNT(*) AS count FROM hospital_notifications WHERE acknowledged_at IS NULL'
  );
  const [escalatedAcks] = await pool.query(
    'SELECT COUNT(*) AS count FROM hospital_notifications WHERE escalated_at IS NOT NULL AND acknowledged_at IS NULL'
  );

  return {
    totalClosedIncidents: timings.length,
    responseTimeBenchmarkSeconds: env.responseTimeBenchmarkSeconds,
    benchmarkMet: {
      count: withinBenchmark,
      total: callToScene.length,
      percent: callToScene.length > 0 ? Math.round((withinBenchmark / callToScene.length) * 100) : null,
    },
    callToDispatch: summarizeDurations(timings.map((t) => t.callToDispatchSeconds)),
    callToScene: summarizeDurations(timings.map((t) => t.callToSceneSeconds)),
    sceneToHospital: summarizeDurations(timings.map((t) => t.sceneToHospitalSeconds)),
    volumeByPriority,
    volumeByHour,
    volumeByDayOfWeek,
    volumeByWeek,
    volumeByProvider: Object.fromEntries(
      Object.entries(volumeByProvider).map(([id, count]) => [providerNames[id] || `#${id}`, count])
    ),
    hospitalAcknowledgment: {
      pending: pendingAcks[0].count,
      escalated: escalatedAcks[0].count,
    },
    incidents: timings,
  };
}

module.exports = { getSummary, computeIncidentTimings };
