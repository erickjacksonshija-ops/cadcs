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

let currentUser = null;
let map = null;
let socket = null;
let incidents = new Map(); // id -> incident
let incidentMarkers = new Map(); // id -> L.CircleMarker
let ambulanceMarkers = new Map(); // ambulanceId -> L.CircleMarker
let staleAmbulanceIds = new Set();
let selectedIncidentId = null;
let pinMode = false;
let pendingPin = null; // { lat, lng }
let pendingPinMarker = null;

async function init() {
  try {
    const { user } = await apiGet('/api/auth/me');
    if (user.role !== 'dispatcher' && user.role !== 'admin') {
      window.location.href = '/';
      return;
    }
    currentUser = user;
    document.getElementById('user-name').textContent = `${user.name} (${user.role})`;
  } catch {
    return; // apiGet already redirects to '/' on 401
  }

  initMap();
  initSocket();
  await Promise.all([loadIncidents(), loadAmbulances()]);
  renderContextPanel();

  document.getElementById('new-incident-btn').addEventListener('click', startNewIncident);
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await apiPost('/api/auth/logout');
    window.location.href = '/';
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

  socket.on('ambulance:location', ({ ambulanceId, lat, lng, status }) => {
    staleAmbulanceIds.delete(ambulanceId);
    upsertAmbulanceMarker(ambulanceId, lat, lng, status || 'available');
  });

  socket.on('ambulance:signal_lost', ({ ambulanceId }) => {
    staleAmbulanceIds.add(ambulanceId);
    const marker = ambulanceMarkers.get(ambulanceId);
    if (marker) marker.setStyle({ color: AMBULANCE_COLORS.stale, fillColor: AMBULANCE_COLORS.stale });
  });

  socket.on('ambulance:signal_restored', ({ ambulanceId }) => {
    staleAmbulanceIds.delete(ambulanceId);
    const marker = ambulanceMarkers.get(ambulanceId);
    if (marker) marker.setStyle({ color: AMBULANCE_COLORS.available, fillColor: AMBULANCE_COLORS.available });
  });

  socket.on('ambulance:status_changed', ({ ambulanceId, status }) => {
    const marker = ambulanceMarkers.get(ambulanceId);
    if (marker && !staleAmbulanceIds.has(ambulanceId)) {
      const color = AMBULANCE_COLORS[status] || AMBULANCE_COLORS.available;
      marker.setStyle({ color, fillColor: color });
    }
    // A status change on the assigned ambulance usually means the
    // incident's own status changed too -- refresh if it's the one open.
    if (selectedIncidentId) refreshSelectedIncident();
    loadIncidents();
  });

  socket.on('connect_error', (err) => {
    console.error('Socket connection failed:', err.message);
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

  socket.on('incident:cancelled', (incident) => {
    incidents.delete(incident.id);
    if (selectedIncidentId === incident.id) selectedIncidentId = null;
    renderIncidentsList();
    renderIncidentMarkers();
    renderContextPanel();
  });
}

function upsertAmbulanceMarker(ambulanceId, lat, lng, status) {
  const color = staleAmbulanceIds.has(ambulanceId) ? AMBULANCE_COLORS.stale : (AMBULANCE_COLORS[status] || AMBULANCE_COLORS.available);
  let marker = ambulanceMarkers.get(ambulanceId);
  if (!marker) {
    marker = L.circleMarker([lat, lng], {
      radius: 8,
      color,
      fillColor: color,
      fillOpacity: 0.9,
      weight: 2,
    }).addTo(map);
    marker.bindTooltip(`Ambulance #${ambulanceId}`);
    ambulanceMarkers.set(ambulanceId, marker);
  } else {
    marker.setLatLng([lat, lng]);
    marker.setStyle({ color, fillColor: color });
  }
}

async function loadAmbulances() {
  const { ambulances } = await apiGet('/api/ambulances');
  for (const amb of ambulances) {
    if (amb.lat !== null && amb.lng !== null) {
      upsertAmbulanceMarker(amb.id, amb.lat, amb.lng, amb.status);
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
    card.className = 'incident-card' + (incident.id === selectedIncidentId ? ' selected' : '');
    card.innerHTML = `
      <div class="top-row">
        <span class="badge ${PRIORITY_BADGE_CLASS[incident.priority]}">${incident.priority}</span>
        <span class="status">${incident.status}</span>
      </div>
      <div style="margin-top:0.3rem;">${escapeHtml(incident.chief_complaint)}</div>
      <div class="muted">${escapeHtml(incident.location_description) || 'No description'}</div>
    `;
    card.addEventListener('click', () => selectIncident(incident.id));
    container.appendChild(card);
  }
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
    renderNewIncidentForm(panel);
    return;
  }
  if (selectedIncidentId && incidents.has(selectedIncidentId)) {
    renderIncidentDetail(panel, incidents.get(selectedIncidentId));
    return;
  }
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

function renderNewIncidentForm(panel) {
  if (!pendingPin) {
    panel.innerHTML = `
      <p class="pin-hint">Click on the map to set the incident location.</p>
      <button class="secondary" id="cancel-new">Cancel</button>
    `;
    document.getElementById('cancel-new').addEventListener('click', cancelNewIncident);
    return;
  }

  panel.innerHTML = `
    <div id="form-error"></div>
    <div class="section-title">New Incident</div>
    <p class="muted">Location: ${pendingPin.lat.toFixed(5)}, ${pendingPin.lng.toFixed(5)}
      <a href="#" id="repin">(change)</a></p>

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

  panel.innerHTML = `
    <div id="detail-error"></div>
    <div class="section-title">Incident #${incident.id}</div>
    <span class="badge ${PRIORITY_BADGE_CLASS[incident.priority]}">${incident.priority}</span>
    <span class="muted">${incident.required_capability} required</span>
    <p><strong>${escapeHtml(incident.chief_complaint)}</strong></p>
    <p class="muted">${escapeHtml(incident.location_description) || 'No description'}</p>
    ${incident.patient_notes ? `<p>${escapeHtml(incident.patient_notes)}</p>` : ''}
    <p class="muted">Status: ${incident.status}</p>

    ${candidatesSection}
    ${cancelSection}
  `;

  const loadBtn = document.getElementById('load-candidates');
  if (loadBtn) loadBtn.addEventListener('click', () => loadCandidates(incident.id));

  const cancelBtn = document.getElementById('cancel-incident-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => promptCancelIncident(incident.id));
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
