// CADCS Dispatcher Dashboard -- vanilla JS, no framework (matches the
// proposal's stated stack). One file kept deliberately simple: DOM
// manipulation + Leaflet + Socket.IO, no build step.

const MBEYA_CENTER = [-8.9094, 33.4607]; // matches the OSRM coverage area
const PRIORITY_BADGE_CLASS = { P1: 'badge-p1', P2: 'badge-p2', P3: 'badge-p3' };
const AMBULANCE_COLORS = {
  available: '#22c55e',
  dispatched: '#f59e0b',
  en_route: '#f59e0b',
  on_scene: '#f59e0b',
  transporting: '#f59e0b',
  at_hospital: '#f59e0b',
  out_of_service: '#64748b',
  stale: '#ef4444',
};
const AMBULANCE_STATUS_LABELS = {
  available: 'Available',
  dispatched: 'Dispatched',
  en_route: 'En Route',
  on_scene: 'On Scene',
  transporting: 'Transporting',
  at_hospital: 'At Hospital',
  out_of_service: 'Out of Service',
};

let currentUser = null;
let map = null;
let socket = null;
let incidents = new Map(); // id -> incident
let incidentMarkers = new Map(); // id -> L.CircleMarker
let ambulanceMarkers = new Map(); // ambulanceId -> L.CircleMarker
let ambulanceMeta = new Map(); // ambulanceId -> { callSign, capabilityLevel } -- events that only carry a status (e.g. ambulance:status_changed) still need this to rebuild a full tooltip
let staleAmbulanceIds = new Set();
let selectedIncidentId = null;
let pinMode = false;
let pendingPin = null; // { lat, lng }
let pendingPinMarker = null;
let responseTimeBenchmarkSeconds = 480; // 8 min WHO benchmark default -- overwritten from /api/auth/me's config on init

// Marker motion smoothing: pings arrive as discrete snapshots, but a marker
// that jumps between them reads as broken, not "live". Instead we animate
// each marker from its last rendered position to the new one over roughly
// the real gap between pings, so motion on the map looks continuous like a
// live vehicle rather than a teleporting dot.
const ambulanceAnimations = new Map(); // ambulanceId -> { fromLat, fromLng, toLat, toLng, startTs, durationMs }
const lastPingClientTs = new Map(); // ambulanceId -> Date.now() of last received ping
let animationFrameId = null;
const MIN_ANIMATION_MS = 800;
const MAX_ANIMATION_MS = 4000;

function scheduleMarkerAnimation(ambulanceId, fromLat, fromLng, toLat, toLng, durationMs) {
  ambulanceAnimations.set(ambulanceId, { fromLat, fromLng, toLat, toLng, startTs: performance.now(), durationMs });
  if (!animationFrameId) animationFrameId = requestAnimationFrame(stepMarkerAnimations);
}

function stepMarkerAnimations(now) {
  let stillAnimating = false;
  for (const [ambulanceId, anim] of ambulanceAnimations) {
    const marker = ambulanceMarkers.get(ambulanceId);
    if (!marker) {
      ambulanceAnimations.delete(ambulanceId);
      continue;
    }
    const t = Math.min(1, (now - anim.startTs) / anim.durationMs);
    const eased = 1 - (1 - t) * (1 - t); // ease-out: fast start, settles into the new ping
    marker.setLatLng([
      anim.fromLat + (anim.toLat - anim.fromLat) * eased,
      anim.fromLng + (anim.toLng - anim.fromLng) * eased,
    ]);
    if (t < 1) {
      stillAnimating = true;
    } else {
      ambulanceAnimations.delete(ambulanceId);
    }
  }
  animationFrameId = stillAnimating ? requestAnimationFrame(stepMarkerAnimations) : null;
}

async function init() {
  try {
    const { user, config } = await apiGet('/api/auth/me');
    if (user.role !== 'dispatcher' && user.role !== 'admin') {
      window.location.href = '/';
      return;
    }
    currentUser = user;
    document.getElementById('user-name').textContent = `${user.name} (${user.role})`;
    if (config && config.responseTimeBenchmarkSeconds) {
      responseTimeBenchmarkSeconds = config.responseTimeBenchmarkSeconds;
    }
  } catch {
    return; // apiGet already redirects to '/' on 401
  }

  initMap();
  initSocket();
  await Promise.all([loadIncidents(), loadAmbulances()]);
  renderContextPanel();

  // Re-renders just the incidents list so aging severity classes/timers
  // keep advancing even when nothing else about the board has changed.
  setInterval(renderIncidentsList, 10000);

  document.getElementById('new-incident-btn').addEventListener('click', startNewIncident);
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await apiPost('/api/auth/logout');
    window.location.href = '/';
  });

  await initNotificationsButton();
}

// Web Push opt-in (see plan: "Notification Reliability") -- reaches a
// dispatcher even when the dashboard tab is backgrounded, for hospital-ack
// escalation alerts specifically (see sockets/index.js's escalation sweep).
const PUSH_SW_PATH = '/dispatcher/service-worker.js';

async function initNotificationsButton() {
  const btn = document.getElementById('notifications-btn');
  const statusEl = document.getElementById('notifications-status');
  const enabled = await isPushEnabled(PUSH_SW_PATH);
  btn.textContent = enabled ? 'Notifications on' : 'Enable notifications';
  btn.disabled = enabled;

  const STATUS_MESSAGES = {
    denied: 'Permission denied -- allow notifications in your browser settings.',
    unsupported: 'Not supported in this browser.',
    unavailable: 'Not configured on this server yet.',
  };

  btn.addEventListener('click', async () => {
    statusEl.textContent = '';
    const result = await enablePushNotifications(PUSH_SW_PATH);
    if (result === 'enabled') {
      btn.textContent = 'Notifications on';
      btn.disabled = true;
    } else {
      statusEl.textContent = STATUS_MESSAGES[result] || '';
    }
  });
}

function initMap() {
  map = L.map('map').setView(MBEYA_CENTER, 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);

  map.on('click', (e) => {
    if (!pinMode) return;
    setPendingPin(e.latlng.lat, e.latlng.lng);
  });
}

function initSocket() {
  socket = io({ auth: { token: getToken() } });

  socket.on('ambulance:location', ({ ambulanceId, lat, lng, status, callSign, capabilityLevel }) => {
    staleAmbulanceIds.delete(ambulanceId);
    upsertAmbulanceMarker(ambulanceId, lat, lng, status || 'available', { callSign, capabilityLevel });
  });

  socket.on('ambulance:signal_lost', ({ ambulanceId }) => {
    staleAmbulanceIds.add(ambulanceId);
    const marker = ambulanceMarkers.get(ambulanceId);
    if (marker) {
      marker.setStyle({ color: AMBULANCE_COLORS.stale, fillColor: AMBULANCE_COLORS.stale });
      marker.setTooltipContent(ambulanceTooltipText(ambulanceId));
    }
  });

  socket.on('ambulance:signal_restored', ({ ambulanceId }) => {
    staleAmbulanceIds.delete(ambulanceId);
    const marker = ambulanceMarkers.get(ambulanceId);
    if (marker) {
      marker.setStyle({ color: AMBULANCE_COLORS.available, fillColor: AMBULANCE_COLORS.available });
      marker.setTooltipContent(ambulanceTooltipText(ambulanceId, 'available'));
    }
  });

  socket.on('ambulance:status_changed', ({ ambulanceId, status }) => {
    const marker = ambulanceMarkers.get(ambulanceId);
    if (marker && !staleAmbulanceIds.has(ambulanceId)) {
      const color = AMBULANCE_COLORS[status] || AMBULANCE_COLORS.available;
      marker.setStyle({ color, fillColor: color });
      marker.setTooltipContent(ambulanceTooltipText(ambulanceId, status));
    }
    // A status change on the assigned ambulance usually means the
    // incident's own status changed too -- refresh if it's the one open.
    if (selectedIncidentId) refreshSelectedIncident();
    loadIncidents();
  });

  socket.on('connect_error', (err) => {
    console.error('Socket connection failed:', err.message);
  });

  // Mission chat: only append live if the chat panel for that exact
  // incident is currently open, otherwise it's picked up fresh next time
  // loadMissionMessages() runs for that incident.
  socket.on('mission:message', (message) => {
    if (selectedIncidentId === message.incidentId) {
      appendMissionMessage(message);
    }
  });

  // Crew panic button -- highest-urgency alert in the app, so it gets a
  // full-screen flash plus a persistent banner (not just a toast that can
  // be missed), regardless of which incident is currently open.
  socket.on('mission:sos', (alert) => {
    flashSosAlert();
    showSosBanner(alert);
    if (selectedIncidentId === alert.incidentId) refreshSelectedIncident();
  });

  // Keeps every dispatcher's list/map in sync, not just the one who
  // triggered the change -- the whole point of shared, cross-provider
  // visibility (see incidentService/dispatchService broadcasts).
  socket.on('incident:created', (incident) => {
    if (incidents.has(incident.id)) return; // avoid duplicate render for the creator's own action
    incidents.set(incident.id, incident);
    renderIncidentsList();
    renderIncidentMarkers();
  });

  socket.on('incident:assigned', (incident) => {
    incidents.set(incident.id, incident);
    renderIncidentsList();
    if (selectedIncidentId === incident.id) renderContextPanel();
  });

  socket.on('incident:priority_changed', (incident) => {
    incidents.set(incident.id, incident);
    renderIncidentsList();
    renderIncidentMarkers();
    if (selectedIncidentId === incident.id) renderContextPanel();
  });

  socket.on('incident:cancelled', (incident) => {
    incidents.delete(incident.id);
    if (selectedIncidentId === incident.id) selectedIncidentId = null;
    renderIncidentsList();
    renderIncidentMarkers();
    renderContextPanel();
  });
}

function ambulanceTooltipText(ambulanceId, status) {
  const meta = ambulanceMeta.get(ambulanceId) || {};
  const label = staleAmbulanceIds.has(ambulanceId)
    ? 'Signal lost'
    : (AMBULANCE_STATUS_LABELS[status] || status || 'Unknown');
  const name = meta.callSign
    ? `${escapeHtml(meta.callSign)}${meta.capabilityLevel ? ` (${escapeHtml(meta.capabilityLevel)})` : ''}`
    : `Ambulance #${ambulanceId}`;
  return `${name} &mdash; ${escapeHtml(label)}`;
}

// meta (callSign/capabilityLevel) is optional -- events that only report a
// status change (not the full REST/GPS payload) can omit it and this
// falls back to whatever was already known for that ambulance.
function upsertAmbulanceMarker(ambulanceId, lat, lng, status, meta) {
  if (meta) ambulanceMeta.set(ambulanceId, meta);
  const color = staleAmbulanceIds.has(ambulanceId) ? AMBULANCE_COLORS.stale : (AMBULANCE_COLORS[status] || AMBULANCE_COLORS.available);
  const tooltipText = ambulanceTooltipText(ambulanceId, status);
  let marker = ambulanceMarkers.get(ambulanceId);
  const now = Date.now();
  if (!marker) {
    marker = L.circleMarker([lat, lng], {
      radius: 8,
      color,
      fillColor: color,
      fillOpacity: 0.9,
      weight: 2,
    }).addTo(map);
    marker.bindTooltip(tooltipText);
    ambulanceMarkers.set(ambulanceId, marker);
  } else {
    const from = marker.getLatLng();
    const lastTs = lastPingClientTs.get(ambulanceId);
    const durationMs = lastTs
      ? Math.min(MAX_ANIMATION_MS, Math.max(MIN_ANIMATION_MS, now - lastTs))
      : MIN_ANIMATION_MS;
    scheduleMarkerAnimation(ambulanceId, from.lat, from.lng, lat, lng, durationMs);
    marker.setStyle({ color, fillColor: color });
    marker.setTooltipContent(tooltipText);
  }
  lastPingClientTs.set(ambulanceId, now);
}

async function loadAmbulances() {
  const { ambulances } = await apiGet('/api/ambulances');
  for (const amb of ambulances) {
    if (amb.lat !== null && amb.lng !== null) {
      upsertAmbulanceMarker(amb.id, amb.lat, amb.lng, amb.status, {
        callSign: amb.call_sign,
        capabilityLevel: amb.capability_level,
      });
    }
  }
}

async function loadIncidents() {
  // "active" = everything not yet closed/cancelled -- the dispatcher board
  // tracks a case through its whole lifecycle (en_route/on_scene/etc), not
  // just up to the moment it's assigned.
  const { incidents: list } = await apiGet('/api/incidents?active=true');
  incidents.clear();
  list.forEach((inc) => incidents.set(inc.id, inc));
  renderIncidentsList();
  renderIncidentMarkers();
}

function renderIncidentsList() {
  const container = document.getElementById('incidents-list');
  container.innerHTML = '';
  const sorted = [...incidents.values()].sort((a, b) => new Date(b.reported_at) - new Date(a.reported_at));

  if (sorted.length === 0) {
    container.innerHTML = '<p class="muted">No active incidents.</p>';
    return;
  }

  for (const incident of sorted) {
    const card = document.createElement('div');
    const aging = agingSeverity(incident);
    card.className = 'incident-card' + (incident.id === selectedIncidentId ? ' selected' : '') + (aging ? ` ${aging}` : '');
    card.innerHTML = `
      <div class="top-row">
        <span class="badge ${PRIORITY_BADGE_CLASS[incident.priority]}">${incident.priority}</span>
        <span class="status">${incident.status}</span>
      </div>
      <div style="margin-top:0.3rem;">${escapeHtml(incident.chief_complaint)}</div>
      <div class="muted">${escapeHtml(incident.location_description) || 'No description'}</div>
      ${aging ? `<div class="aging-text">Unassigned ${formatElapsed(incident.reported_at)}</div>` : ''}
    `;
    card.addEventListener('click', () => selectIncident(incident.id));
    container.appendChild(card);
  }
}

// Live SLA-aging: an unassigned incident should visibly escalate on the
// board as it approaches the WHO response-time benchmark, not just get
// scored against it after the fact in analytics -- gives the dispatcher a
// chance to act before the benchmark is actually breached, not just a
// post-mortem number.
function agingSeverity(incident) {
  if (incident.status !== 'reported') return null;
  const elapsedSeconds = (Date.now() - new Date(incident.reported_at).getTime()) / 1000;
  const ratio = elapsedSeconds / responseTimeBenchmarkSeconds;
  if (ratio >= 1) return 'aging-breached';
  if (ratio >= 0.75) return 'aging-critical';
  if (ratio >= 0.5) return 'aging-warning';
  return null;
}

function formatElapsed(reportedAt) {
  const totalSeconds = Math.max(0, Math.floor((Date.now() - new Date(reportedAt).getTime()) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function renderIncidentMarkers() {
  for (const [id, marker] of incidentMarkers) {
    if (!incidents.has(id)) {
      map.removeLayer(marker);
      incidentMarkers.delete(id);
    }
  }
  for (const incident of incidents.values()) {
    const color = incident.priority === 'P1' ? '#ef4444' : incident.priority === 'P2' ? '#f59e0b' : '#22c55e';
    let marker = incidentMarkers.get(incident.id);
    if (!marker) {
      marker = L.marker([incident.lat, incident.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:2px solid white;"></div>`,
          iconSize: [16, 16],
        }),
      }).addTo(map);
      marker.on('click', () => selectIncident(incident.id));
      incidentMarkers.set(incident.id, marker);
    }
  }
}

function selectIncident(id) {
  selectedIncidentId = id;
  pinMode = false;
  document.getElementById('map').classList.remove('pin-mode');
  renderIncidentsList();
  renderContextPanel();
}

async function refreshSelectedIncident() {
  if (!selectedIncidentId) return;
  try {
    const { incident } = await apiGet(`/api/incidents/${selectedIncidentId}`);
    incidents.set(incident.id, incident);
    if (incident.status === 'closed' || incident.status === 'cancelled') {
      incidents.delete(incident.id);
      selectedIncidentId = null;
    }
    renderIncidentsList();
    renderIncidentMarkers();
    renderContextPanel();
  } catch {
    // incident may have moved past dispatcher-visible states
  }
}

function renderContextPanel() {
  const panel = document.getElementById('context-panel');
  if (pinMode || pendingPin) {
    stopEtaPolling();
    renderNewIncidentForm(panel);
    return;
  }
  if (selectedIncidentId && incidents.has(selectedIncidentId)) {
    renderIncidentDetail(panel, incidents.get(selectedIncidentId));
    return;
  }
  stopEtaPolling();
  panel.innerHTML = '<p class="muted">Select an incident, or create a new one, to see details here.</p>';
}

function startNewIncident() {
  selectedIncidentId = null;
  pinMode = true;
  pendingPin = null;
  document.getElementById('map').classList.add('pin-mode');
  renderIncidentsList();
  renderContextPanel();
}

function setPendingPin(lat, lng) {
  pendingPin = { lat, lng };
  pinMode = false;
  document.getElementById('map').classList.remove('pin-mode');
  if (pendingPinMarker) map.removeLayer(pendingPinMarker);
  pendingPinMarker = L.marker([lat, lng]).addTo(map);
  renderContextPanel();
}

// Address/landmark search, secondary to click-to-pin (see plan: "Incident
// Intake & Location Capture") -- click-to-pin always works with zero
// external dependency, this just saves a dispatcher from having to
// eyeball a location on the map when the caller gave a nameable landmark.
async function runLocationSearch() {
  const input = document.getElementById('location-search-input');
  const resultsBox = document.getElementById('location-search-results');
  const q = input.value.trim();
  if (q.length < 2) return;

  resultsBox.innerHTML = '<p class="muted">Searching...</p>';
  try {
    const { results, unavailable } = await apiGet(`/api/geocode/search?q=${encodeURIComponent(q)}`);
    if (unavailable) {
      resultsBox.innerHTML = '<p class="muted">Address search is unavailable right now -- click the map instead.</p>';
      return;
    }
    if (results.length === 0) {
      resultsBox.innerHTML = '<p class="muted">No matches -- try a different search, or click the map instead.</p>';
      return;
    }
    resultsBox.innerHTML = results.map((r, i) => `
      <div class="search-result" data-index="${i}">${escapeHtml(r.displayName)}</div>
    `).join('');
    resultsBox.querySelectorAll('.search-result').forEach((el) => {
      el.addEventListener('click', () => {
        const r = results[Number(el.dataset.index)];
        map.setView([r.lat, r.lng], 16);
        setPendingPin(r.lat, r.lng);
      });
    });
  } catch (err) {
    resultsBox.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
  }
}

function renderNewIncidentForm(panel) {
  if (!pendingPin) {
    panel.innerHTML = `
      <label for="location-search-input">Search address or landmark</label>
      <div class="field-row">
        <input id="location-search-input" placeholder="e.g. Mbeya Zonal Referral Hospital" />
        <button class="secondary" id="location-search-btn" style="flex:0;">Search</button>
      </div>
      <div id="location-search-results"></div>
      <p class="pin-hint">...or click on the map to set the incident location.</p>
      <button class="secondary" id="cancel-new">Cancel</button>
    `;
    document.getElementById('cancel-new').addEventListener('click', cancelNewIncident);
    document.getElementById('location-search-btn').addEventListener('click', runLocationSearch);
    document.getElementById('location-search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runLocationSearch(); }
    });
    return;
  }

  panel.innerHTML = `
    <div id="form-error"></div>
    <div class="section-title">New Incident</div>
    <p class="muted">Location: ${pendingPin.lat.toFixed(5)}, ${pendingPin.lng.toFixed(5)}
      <a href="#" id="repin">(change)</a></p>
    <div id="duplicate-check"></div>

    <label for="chiefComplaint">Chief complaint</label>
    <select id="chiefComplaint">
      <option value="trauma">Trauma</option>
      <option value="cardiac">Cardiac</option>
      <option value="obstetric">Obstetric</option>
      <option value="respiratory">Respiratory</option>
      <option value="other">Other</option>
    </select>

    <div class="section-title">Red flags</div>
    <div class="checkbox-row"><input type="checkbox" id="rf-unconscious" /><label for="rf-unconscious">Unconscious</label></div>
    <div class="checkbox-row"><input type="checkbox" id="rf-notBreathing" /><label for="rf-notBreathing">Not breathing</label></div>
    <div class="checkbox-row"><input type="checkbox" id="rf-severeBleeding" /><label for="rf-severeBleeding">Severe bleeding</label></div>

    <label for="locationDescription">Location description</label>
    <input id="locationDescription" placeholder="e.g. near the market, past the bridge" />

    <label for="callerPhone">Caller phone</label>
    <input id="callerPhone" placeholder="+255..." />

    <label for="patientNotes">Patient notes</label>
    <textarea id="patientNotes" rows="3"></textarea>

    <button id="submit-incident" style="width:100%; margin-top:1rem;">Create Incident</button>
    <button class="secondary" id="cancel-new" style="width:100%; margin-top:0.5rem;">Cancel</button>
  `;

  document.getElementById('repin').addEventListener('click', (e) => {
    e.preventDefault();
    if (pendingPinMarker) { map.removeLayer(pendingPinMarker); pendingPinMarker = null; }
    pendingPin = null;
    pinMode = true;
    document.getElementById('map').classList.add('pin-mode');
    renderContextPanel();
  });
  document.getElementById('cancel-new').addEventListener('click', cancelNewIncident);
  document.getElementById('submit-incident').addEventListener('click', submitNewIncident);
  checkNearbyDuplicates(pendingPin.lat, pendingPin.lng);
}

// Advisory only -- flags open incidents reported near this pin in the last
// ~20 minutes so a dispatcher can spot "this is probably the same crash a
// different caller just reported" before creating a redundant incident and
// double-dispatching a second ambulance to one scene.
async function checkNearbyDuplicates(lat, lng) {
  const box = document.getElementById('duplicate-check');
  if (!box) return;
  try {
    const { incidents: nearby } = await apiGet(`/api/incidents/nearby-open?lat=${lat}&lng=${lng}`);
    if (nearby.length === 0) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = `
      <div class="duplicate-warning">
        <strong>Possible duplicate report${nearby.length > 1 ? 's' : ''} nearby:</strong>
        ${nearby.map((n) => `
          <div class="duplicate-row" data-id="${n.id}">
            #${n.id} &middot; ${escapeHtml(n.chief_complaint)} &middot; ${Math.round(n.distance_meters)}m away &middot; ${new Date(n.reported_at).toLocaleTimeString()}
          </div>
        `).join('')}
        <p class="muted" style="margin-top:0.3rem;">Click one to view it instead, or continue below if this is a genuinely separate call.</p>
      </div>
    `;
    box.querySelectorAll('.duplicate-row').forEach((el) => {
      el.addEventListener('click', () => {
        cancelNewIncident();
        selectIncident(Number(el.dataset.id));
      });
    });
  } catch {
    box.innerHTML = ''; // advisory check only -- fail silent, never block incident creation
  }
}

function cancelNewIncident() {
  pinMode = false;
  pendingPin = null;
  document.getElementById('map').classList.remove('pin-mode');
  if (pendingPinMarker) { map.removeLayer(pendingPinMarker); pendingPinMarker = null; }
  renderContextPanel();
}

async function submitNewIncident() {
  const errorBox = document.getElementById('form-error');
  errorBox.innerHTML = '';

  const payload = {
    lat: pendingPin.lat,
    lng: pendingPin.lng,
    chiefComplaint: document.getElementById('chiefComplaint').value,
    redFlags: {
      unconscious: document.getElementById('rf-unconscious').checked,
      notBreathing: document.getElementById('rf-notBreathing').checked,
      severeBleeding: document.getElementById('rf-severeBleeding').checked,
    },
    locationDescription: document.getElementById('locationDescription').value || undefined,
    callerPhone: document.getElementById('callerPhone').value || undefined,
    patientNotes: document.getElementById('patientNotes').value || undefined,
  };

  try {
    const { incident } = await apiPost('/api/incidents', payload);
    if (pendingPinMarker) { map.removeLayer(pendingPinMarker); pendingPinMarker = null; }
    pendingPin = null;
    incidents.set(incident.id, incident);
    selectedIncidentId = incident.id;
    renderIncidentsList();
    renderIncidentMarkers();
    renderContextPanel();
  } catch (err) {
    errorBox.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
  }
}

// Statuses for which /:id/eta can return something meaningful -- mirrors
// ETA_TARGETS_SCENE + 'transporting' on the server (see routes/incidents.js).
const ETA_APPLICABLE_STATUSES = ['assigned', 'dispatched', 'en_route', 'on_scene', 'transporting'];

const PRE_ARRIVAL_APPLICABLE_STATUSES = ['reported', 'assigned', 'dispatched', 'en_route'];

async function loadPreArrivalInstructions(incidentId) {
  const container = document.getElementById('pre-arrival-container');
  if (!container) return;
  container.innerHTML = '<p class="muted">Loading&hellip;</p>';
  try {
    const { title, steps } = await apiGet(`/api/incidents/${incidentId}/pre-arrival-instructions`);
    container.innerHTML = `
      <div class="pre-arrival-card">
        <strong>${escapeHtml(title)}</strong>
        <ol>${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
  }
}

function renderIncidentDetail(panel, incident) {
  // Ranking/assignment only makes sense before an ambulance has been
  // claimed -- once assigned, the incident is tracked read-only here as
  // it moves through the crew-driven lifecycle.
  const candidatesSection = incident.status === 'reported'
    ? `
      <div class="section-title">Candidates</div>
      <button id="load-candidates">Get ranked candidates</button>
      <div id="candidates-list"></div>
    `
    : `<p class="muted">Ambulance #${incident.assigned_ambulance_id} assigned. Tracking crew-reported status.</p>`;

  // Cancellation (false alarm / duplicate report) is only meaningful
  // before a crew has actively committed to responding -- matches the
  // same rule dispatchService.cancelIncident enforces server-side.
  const cancelSection = ['reported', 'assigned'].includes(incident.status)
    ? `<button class="danger" id="cancel-incident-btn" style="width:100%; margin-top:1rem;">Cancel incident</button>`
    : '';

  const etaSection = ETA_APPLICABLE_STATUSES.includes(incident.status)
    ? `<p class="muted" id="live-eta">Fetching live ETA&hellip;</p>`
    : '';

  // Only useful while the dispatcher might still be coaching the caller --
  // once crew is physically on scene, the caller is being cared for
  // directly and doesn't need phone instructions anymore.
  const preArrivalSection = PRE_ARRIVAL_APPLICABLE_STATUSES.includes(incident.status)
    ? `
      <button class="secondary" id="pre-arrival-btn" style="width:100%; margin-top:0.5rem;">Pre-arrival instructions</button>
      <div id="pre-arrival-container"></div>
    `
    : '';

  // Chat only makes sense once a specific crew is actually attached to
  // this incident -- before that ('reported'), there's no ambulance room
  // to reach on the other end.
  const chatSection = incident.assigned_ambulance_id
    ? `
      <div class="section-title">Mission Chat</div>
      <div id="mission-chat-log" class="chat-log"></div>
      <div class="field-row">
        <input id="mission-chat-input" placeholder="Message the crew..." maxlength="500" />
        <button id="mission-chat-send" style="flex:0;">Send</button>
      </div>
    `
    : '';

  // Re-triage is only meaningful while the incident is still active --
  // matches the same closed/cancelled guard dispatchService.escalatePriority
  // enforces server-side.
  const priorityChangeSection = !['closed', 'cancelled'].includes(incident.status)
    ? `<a href="#" id="change-priority-link" class="muted" style="margin-left:0.5rem;">change</a>
       <div id="priority-change-form"></div>`
    : '';

  panel.innerHTML = `
    <div id="detail-error"></div>
    <div class="section-title">Incident #${incident.id}</div>
    <span class="badge ${PRIORITY_BADGE_CLASS[incident.priority]}">${incident.priority}</span>
    <span class="muted">${incident.required_capability} required</span>
    ${priorityChangeSection}
    <p><strong>${escapeHtml(incident.chief_complaint)}</strong></p>
    <p class="muted">${escapeHtml(incident.location_description) || 'No description'}</p>
    ${incident.patient_notes ? `<p>${escapeHtml(incident.patient_notes)}</p>` : ''}
    <p class="muted">Status: ${incident.status}</p>
    ${etaSection}
    ${preArrivalSection}

    ${candidatesSection}
    ${chatSection}
    <button class="secondary" id="view-timeline-btn" style="width:100%; margin-top:0.75rem;">View audit timeline</button>
    <div id="timeline-container"></div>
    ${cancelSection}
  `;

  const loadBtn = document.getElementById('load-candidates');
  if (loadBtn) loadBtn.addEventListener('click', () => loadCandidates(incident.id));

  const cancelBtn = document.getElementById('cancel-incident-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => promptCancelIncident(incident.id));

  document.getElementById('view-timeline-btn').addEventListener('click', () => loadTimeline(incident.id));

  const preArrivalBtn = document.getElementById('pre-arrival-btn');
  if (preArrivalBtn) preArrivalBtn.addEventListener('click', () => loadPreArrivalInstructions(incident.id));

  const changePriorityLink = document.getElementById('change-priority-link');
  if (changePriorityLink) {
    changePriorityLink.addEventListener('click', (e) => {
      e.preventDefault();
      renderPriorityChangeForm(incident);
    });
  }

  if (document.getElementById('mission-chat-input')) {
    loadMissionMessages(incident.id);
    document.getElementById('mission-chat-send').addEventListener('click', () => sendMissionMessage(incident));
    document.getElementById('mission-chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendMissionMessage(incident); }
    });
  }

  if (ETA_APPLICABLE_STATUSES.includes(incident.status)) {
    startEtaPolling(incident.id);
  } else {
    stopEtaPolling();
  }
}

const PRIORITIES = ['P1', 'P2', 'P3'];

// Mid-incident re-triage (see plan: "Mid-incident priority escalation") --
// separate from the triage suggestion shown at creation time. A reason is
// always required so the audit timeline shows why urgency changed, not
// just that it did.
function renderPriorityChangeForm(incident) {
  const container = document.getElementById('priority-change-form');
  if (!container) return;
  container.innerHTML = `
    <div class="priority-change-card">
      <label for="priority-select">New priority</label>
      <select id="priority-select">
        ${PRIORITIES.map((p) => `<option value="${p}" ${p === incident.priority ? 'selected' : ''}>${p}</option>`).join('')}
      </select>
      <label for="priority-reason">Reason (required)</label>
      <input id="priority-reason" placeholder="e.g. caller reports patient now unresponsive" />
      <div id="priority-change-error"></div>
      <button id="submit-priority-change" style="width:100%; margin-top:0.4rem;">Update priority</button>
      <button class="secondary" id="cancel-priority-change" style="width:100%; margin-top:0.3rem;">Cancel</button>
    </div>
  `;
  document.getElementById('cancel-priority-change').addEventListener('click', () => {
    container.innerHTML = '';
  });
  document.getElementById('submit-priority-change').addEventListener('click', () => submitPriorityChange(incident.id));
}

async function submitPriorityChange(incidentId) {
  const errorBox = document.getElementById('priority-change-error');
  const priority = document.getElementById('priority-select').value;
  const reason = document.getElementById('priority-reason').value.trim();
  errorBox.innerHTML = '';
  try {
    const { incident } = await apiPost(`/api/incidents/${incidentId}/priority`, { priority, reason });
    incidents.set(incident.id, incident);
    renderIncidentsList();
    renderContextPanel();
  } catch (err) {
    errorBox.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
  }
}

async function loadMissionMessages(incidentId) {
  const log = document.getElementById('mission-chat-log');
  if (!log) return;
  log.innerHTML = '<p class="muted">Loading messages&hellip;</p>';
  try {
    const { messages } = await apiGet(`/api/incidents/${incidentId}/messages`);
    renderMissionChatLog(messages);
  } catch (err) {
    log.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
  }
}

function renderMissionChatLog(messages) {
  const log = document.getElementById('mission-chat-log');
  if (!log) return;
  log.innerHTML = messages.length === 0 ? '<p class="muted">No messages yet.</p>' : '';
  messages.forEach(appendMissionMessage);
}

function appendMissionMessage(message) {
  const log = document.getElementById('mission-chat-log');
  if (!log || selectedIncidentId !== message.incidentId) return;
  const placeholder = log.querySelector('.muted');
  if (placeholder) placeholder.remove();
  const row = document.createElement('div');
  row.className = `chat-msg chat-msg-${message.senderRole}`;
  row.innerHTML = `
    <span class="chat-msg-sender">${escapeHtml(message.senderName)}</span>
    <span class="chat-msg-body">${escapeHtml(message.body)}</span>
    <span class="chat-msg-time muted">${new Date(message.sentAt).toLocaleTimeString()}</span>
  `;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

function sendMissionMessage(incident) {
  const input = document.getElementById('mission-chat-input');
  const body = input.value.trim();
  if (!body) return;
  socket.emit('mission:message', { ambulanceId: incident.assigned_ambulance_id, body });
  input.value = '';
}

// Recomputes ETA from the assigned ambulance's live GPS position every 20s
// (see GET /api/incidents/:id/eta) so the dispatcher sees a countdown that
// actually ticks down, instead of a number frozen at assignment time --
// matches how ride-hailing apps keep a rider's ETA live during the trip.
const ETA_POLL_INTERVAL_MS = 20000;
let etaPollTimerId = null;
let etaPollIncidentId = null;

function stopEtaPolling() {
  if (etaPollTimerId) clearInterval(etaPollTimerId);
  etaPollTimerId = null;
  etaPollIncidentId = null;
}

function startEtaPolling(incidentId) {
  if (etaPollIncidentId === incidentId) return; // already polling this one
  stopEtaPolling();
  etaPollIncidentId = incidentId;
  fetchAndRenderEta(incidentId);
  etaPollTimerId = setInterval(() => fetchAndRenderEta(incidentId), ETA_POLL_INTERVAL_MS);
}

async function fetchAndRenderEta(incidentId) {
  const el = document.getElementById('live-eta');
  if (!el || selectedIncidentId !== incidentId) return; // panel moved on -- drop this tick
  try {
    const { etaSeconds, target } = await apiGet(`/api/incidents/${incidentId}/eta`);
    const label = target === 'hospital' ? 'to hospital' : 'to scene';
    el.textContent = `Live ETA ${label}: ${Math.round(etaSeconds / 60)} min`;
  } catch (err) {
    el.textContent = 'Live ETA unavailable right now';
  }
}

// The append-only incident_events record (see auditService/
// docs/audit-log-integrity.md), rendered as a chronological timeline --
// this is the concrete evidence behind the proposal's non-repudiation
// audit-trail claim (Sec 5), not just raw rows sitting unused in a table.
const EVENT_LABELS = {
  created: 'Incident created',
  triage_suggested: 'Triage suggested',
  priority_overridden: 'Priority overridden',
  candidates_ranked: 'Candidates ranked',
  assigned: 'Ambulance assigned',
  assignment_rejected_conflict: 'Assignment rejected (conflict)',
  dispatched: 'Dispatched',
  status_changed: 'Status changed',
  hospital_notified: 'Hospital notified',
  hospital_ack_escalated: 'Hospital ack escalated',
  hospital_acknowledged: 'Hospital acknowledged',
  cancelled: 'Cancelled',
  closed: 'Closed',
  sos_triggered: 'Crew SOS triggered',
  priority_changed: 'Priority changed',
};

function flashSosAlert() {
  document.body.style.transition = 'none';
  document.body.style.backgroundColor = '#dc2626';
  requestAnimationFrame(() => {
    document.body.style.transition = 'background-color 1.5s';
    document.body.style.backgroundColor = '';
  });
}

// Stacks (doesn't replace) so multiple concurrent SOS alerts from different
// crews all stay visible until a dispatcher explicitly acts on or dismisses
// each one -- this is the highest-urgency signal in the app and must never
// silently get overwritten by the next one.
function showSosBanner(alert) {
  const container = document.getElementById('sos-banner-container');
  const banner = document.createElement('div');
  banner.className = 'sos-banner';
  const label = alert.callSign ? escapeHtml(alert.callSign) : `Ambulance #${alert.ambulanceId}`;
  banner.innerHTML = `
    <span><strong>SOS</strong> &mdash; ${label} needs assistance (Incident #${alert.incidentId}) &mdash; ${new Date(alert.triggeredAt).toLocaleTimeString()}</span>
    <div>
      <button class="view-sos-btn">View incident</button>
      <button class="secondary dismiss-sos-btn">Dismiss</button>
    </div>
  `;
  banner.querySelector('.view-sos-btn').addEventListener('click', () => {
    selectIncident(alert.incidentId);
    banner.remove();
  });
  banner.querySelector('.dismiss-sos-btn').addEventListener('click', () => banner.remove());
  container.appendChild(banner);
}

function formatEventMetadata(eventType, metadata) {
  if (!metadata) return '';
  if (eventType === 'status_changed' && metadata.from && metadata.to) {
    return `${metadata.from} &rarr; ${metadata.to}`;
  }
  if (eventType === 'assigned' && metadata.ambulanceId) {
    return `Ambulance #${metadata.ambulanceId}`;
  }
  if (eventType === 'cancelled' && metadata.reason) {
    return escapeHtml(metadata.reason);
  }
  if (eventType === 'priority_changed' && metadata.from && metadata.to) {
    return `${metadata.from} &rarr; ${metadata.to}${metadata.reason ? ` &mdash; ${escapeHtml(metadata.reason)}` : ''}`;
  }
  if (eventType === 'candidates_ranked') {
    const count = Array.isArray(metadata.candidates) ? metadata.candidates.length : 0;
    return `${count} candidate(s), routing: ${escapeHtml(metadata.routingSource || 'unknown')}`;
  }
  return '';
}

async function loadTimeline(incidentId) {
  const container = document.getElementById('timeline-container');
  container.innerHTML = '<p class="muted">Loading timeline...</p>';
  try {
    const { events } = await apiGet(`/api/incidents/${incidentId}/events`);
    if (events.length === 0) {
      container.innerHTML = '<p class="muted">No events recorded yet.</p>';
      return;
    }
    container.innerHTML = `
      <div class="timeline">
        ${events.map((e) => `
          <div class="timeline-entry">
            <div class="timeline-time muted">${new Date(e.occurred_at).toLocaleString()}</div>
            <div class="timeline-label">${escapeHtml(EVENT_LABELS[e.event_type] || e.event_type)}</div>
            <div class="timeline-meta muted">${formatEventMetadata(e.event_type, typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata)}</div>
          </div>
        `).join('')}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
  }
}

function promptCancelIncident(incidentId) {
  const panel = document.getElementById('context-panel');
  const existingContent = panel.innerHTML;
  panel.innerHTML = `
    <div class="section-title">Cancel incident #${incidentId}</div>
    <div id="cancel-error"></div>
    <label for="cancel-reason">Reason (required)</label>
    <textarea id="cancel-reason" rows="3" placeholder="e.g. duplicate report, false alarm, caller called back"></textarea>
    <button class="danger" id="confirm-cancel-btn" style="width:100%; margin-top:0.75rem;">Confirm cancellation</button>
    <button class="secondary" id="back-btn" style="width:100%; margin-top:0.5rem;">Back</button>
  `;

  document.getElementById('back-btn').addEventListener('click', () => {
    panel.innerHTML = existingContent;
  });

  document.getElementById('confirm-cancel-btn').addEventListener('click', async () => {
    const errorBox = document.getElementById('cancel-error');
    const reason = document.getElementById('cancel-reason').value;
    try {
      await apiPost(`/api/incidents/${incidentId}/cancel`, { reason });
      incidents.delete(incidentId);
      selectedIncidentId = null;
      renderIncidentsList();
      renderIncidentMarkers();
      renderContextPanel();
    } catch (err) {
      errorBox.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
  });
}

async function loadCandidates(incidentId) {
  const list = document.getElementById('candidates-list');
  list.innerHTML = '<p class="muted">Loading...</p>';
  try {
    const { candidates, routingSource } = await apiGet(`/api/incidents/${incidentId}/candidates`);
    if (routingSource === 'haversine_fallback') {
      list.innerHTML = '<p class="error-banner">Road-routing unavailable -- showing straight-line estimate.</p>';
    } else {
      list.innerHTML = '';
    }
    if (candidates.length === 0) {
      list.innerHTML += '<p class="muted">No available ambulances match this incident.</p>';
      return;
    }
    for (const c of candidates) {
      const row = document.createElement('div');
      row.className = 'candidate-row';
      const etaText = c.etaSeconds !== null ? `${Math.round(c.etaSeconds / 60)} min` : `${(c.distanceMeters / 1000).toFixed(1)} km (straight-line)`;
      row.innerHTML = `
        <div>
          <div>${escapeHtml(c.callSign)} <span class="muted">(${c.capabilityLevel})</span></div>
          <div class="meta">${etaText}</div>
        </div>
        <button data-ambulance-id="${c.ambulanceId}">Assign</button>
      `;
      row.querySelector('button').addEventListener('click', () => assignAmbulance(incidentId, c.ambulanceId));
      list.appendChild(row);
    }
  } catch (err) {
    list.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
  }
}

async function assignAmbulance(incidentId, ambulanceId) {
  const errorBox = document.getElementById('detail-error');
  try {
    const { incident } = await apiPost(`/api/incidents/${incidentId}/assign`, { ambulanceId });
    incidents.set(incident.id, incident);
    renderIncidentsList();
    renderContextPanel();
    await loadIncidents();
  } catch (err) {
    errorBox.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    // Ambulance was likely claimed by another dispatcher in the meantime --
    // refresh candidates so the list reflects reality.
    loadCandidates(incidentId);
  }
}

init();
