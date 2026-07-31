// CADCS Crew MDT -- installable PWA, vanilla JS. GPS reporting uses the
// realistic usage pattern described in the plan: phone mounted, app open
// full-screen for the duration of the mission, Wake Lock keeping the
// screen active so watchPosition() keeps firing (mobile browsers throttle
// location updates once the screen locks).

const STATUS_NEXT = {
  assigned: { next: 'en_route', label: 'Start Responding (En Route)' },
  en_route: { next: 'on_scene', label: 'Arrived On Scene' },
  on_scene: { next: 'transporting', label: 'Transporting Patient' },
  transporting: { next: 'at_hospital', label: 'Arrived At Hospital' },
  at_hospital: { next: 'closed', label: 'Complete Mission' },
};

let currentUser = null;
let socket = null;
let currentIncident = null;
let missionMap = null;
let routeLayer = null;
let watchId = null;
let wakeLock = null;
let lastGpsAt = null;

async function init() {
  try {
    const { user } = await apiGet('/api/auth/me');
    if (user.role !== 'crew') {
      window.location.href = '/';
      return;
    }
    currentUser = user;
    document.getElementById('user-name').textContent = user.name;
  } catch {
    return;
  }

  registerServiceWorker();
  initSocket();

  document.getElementById('logout-btn').addEventListener('click', async () => {
    stopGpsReporting();
    await apiPost('/api/auth/logout');
    window.location.href = '/';
  });

  await loadMission();
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/crew/service-worker.js').catch((err) => {
      console.error('Service worker registration failed:', err);
    });
  }
}

function initSocket() {
  socket = io({ auth: { token: getToken() } });

  socket.on('mission:assigned', (incident) => {
    currentIncident = incident;
    renderMissionView();
    startGpsReporting();
  });

  // A dispatcher cancelled the incident (false alarm/duplicate) before the
  // crew reached the scene -- return to the waiting state rather than
  // leaving the crew staring at a mission that no longer exists.
  socket.on('mission:cancelled', ({ incidentId }) => {
    if (currentIncident && currentIncident.id === incidentId) {
      currentIncident = null;
      renderWaitingState();
    }
  });

  // Dispatcher chat: only append live if the chat panel is on screen for
  // this exact mission, otherwise it's picked up fresh next time
  // loadMissionMessages() runs for the current incident.
  socket.on('mission:message', (message) => {
    if (currentIncident && currentIncident.id === message.incidentId) {
      appendMissionMessage(message);
    }
  });

  socket.on('connect_error', (err) => console.error('Socket connection failed:', err.message));
}

async function loadMission() {
  const { incident } = await apiGet('/api/incidents/mine');
  currentIncident = incident;
  if (incident) {
    renderMissionView();
    startGpsReporting();
  } else {
    renderWaitingState();
  }
}

function renderWaitingState() {
  stopGpsReporting();
  document.getElementById('app-content').innerHTML = `
    <div class="waiting-state">
      <div class="pulse"></div>
      <h2>No active mission</h2>
      <p class="muted">Waiting for dispatch. This screen updates automatically.</p>
    </div>
  `;
}

async function renderMissionView() {
  const inc = currentIncident;
  const nextAction = STATUS_NEXT[inc.status];
  // Starting transport is the one transition that needs an extra input --
  // the crew picks a destination hospital, which also triggers that
  // hospital's pre-notification (see dispatchService).
  const needsHospitalPicker = nextAction && nextAction.next === 'transporting';

  document.getElementById('app-content').innerHTML = `
    <div class="panel mission-card">
      <span class="badge ${inc.priority === 'P1' ? 'badge-p1' : inc.priority === 'P2' ? 'badge-p2' : 'badge-p3'}">${inc.priority}</span>
      <span class="muted">${inc.required_capability} required</span>
      <h2>${escapeHtml(inc.chief_complaint)}</h2>
      <p>${escapeHtml(inc.location_description) || 'No location description provided'}</p>
      <div id="mission-map"></div>
      <div id="route-error"></div>
      ${needsHospitalPicker ? '<label for="hospital-picker">Destination hospital</label><select id="hospital-picker"></select>' : ''}
      <button id="status-btn">${nextAction ? nextAction.label : 'Mission complete'}</button>
      <button id="sos-btn" class="danger">SOS -- Alert Dispatch</button>
      <div class="gps-indicator">
        <span id="gps-dot" class="gps-dot off"></span>
        <span id="gps-text">Acquiring GPS...</span>
      </div>

      <div class="section-title">Dispatcher Chat</div>
      <div id="mission-chat-log" class="chat-log"></div>
      <div class="field-row">
        <input id="mission-chat-input" placeholder="Message dispatch..." maxlength="500" />
        <button id="mission-chat-send" style="flex:0;">Send</button>
      </div>
    </div>
  `;

  initMissionMap(inc.lat, inc.lng);
  loadRoute();
  if (needsHospitalPicker) await populateHospitalPicker(inc.id);
  loadMissionMessages(inc.id);

  const btn = document.getElementById('status-btn');
  if (nextAction) {
    btn.addEventListener('click', () => {
      const hospitalId = needsHospitalPicker ? Number(document.getElementById('hospital-picker').value) : undefined;
      submitStatus(nextAction.next, hospitalId);
    });
  } else {
    btn.disabled = true;
  }

  document.getElementById('mission-chat-send').addEventListener('click', sendMissionMessage);
  document.getElementById('mission-chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendMissionMessage(); }
  });

  document.getElementById('sos-btn').addEventListener('click', triggerSos);
}

// One-way panic alert to dispatch (see sockets/index.js's 'mission:sos'
// handler) -- disabled for a cooldown window after sending, both to make
// the "it went through" state visible and to stop repeated accidental taps
// from spamming dispatchers with duplicate alerts.
const SOS_COOLDOWN_MS = 60000;

function triggerSos() {
  const btn = document.getElementById('sos-btn');
  if (!btn || !socket || !socket.connected) return;
  socket.emit('mission:sos');
  btn.disabled = true;
  btn.textContent = 'SOS sent -- dispatch notified';
  setTimeout(() => {
    if (btn.isConnected) {
      btn.disabled = false;
      btn.textContent = 'SOS -- Alert Dispatch';
    }
  }, SOS_COOLDOWN_MS);
}

async function loadMissionMessages(incidentId) {
  const log = document.getElementById('mission-chat-log');
  if (!log) return;
  log.innerHTML = '<p class="muted">Loading messages&hellip;</p>';
  try {
    const { messages } = await apiGet(`/api/incidents/${incidentId}/messages`);
    log.innerHTML = messages.length === 0 ? '<p class="muted">No messages yet.</p>' : '';
    messages.forEach(appendMissionMessage);
  } catch (err) {
    log.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
  }
}

function appendMissionMessage(message) {
  const log = document.getElementById('mission-chat-log');
  if (!log || !currentIncident || currentIncident.id !== message.incidentId) return;
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

function sendMissionMessage() {
  const input = document.getElementById('mission-chat-input');
  const body = input.value.trim();
  if (!body) return;
  socket.emit('mission:message', { body });
  input.value = '';
}

function initMissionMap(destLat, destLng) {
  missionMap = L.map('mission-map').setView([destLat, destLng], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(missionMap);
  L.marker([destLat, destLng]).addTo(missionMap).bindTooltip('Incident location');
}

async function loadRoute() {
  const errorBox = document.getElementById('route-error');
  try {
    const { route } = await apiGet(`/api/incidents/${currentIncident.id}/route`);
    if (routeLayer) missionMap.removeLayer(routeLayer);
    const latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    routeLayer = L.polyline(latlngs, { color: '#38bdf8', weight: 4 }).addTo(missionMap);
    missionMap.fitBounds(routeLayer.getBounds(), { padding: [20, 20] });
    if (errorBox) errorBox.innerHTML = '';
  } catch (err) {
    // 409 = ambulance has no GPS fix yet (route needs an origin) -- not an
    // error worth alarming the crew over, just means "send a ping first."
    if (errorBox && err.status !== 409) {
      errorBox.innerHTML = `<p class="error-banner">${escapeHtml(err.message)}</p>`;
    }
  }
}

async function populateHospitalPicker(incidentId) {
  const select = document.getElementById('hospital-picker');
  if (!select) return;
  try {
    const { hospitals, routingSource } = await apiGet(`/api/incidents/${incidentId}/hospitals`);
    // Ranked nearest-first by real road ETA (or a flagged straight-line
    // fallback if OSRM is unreachable) -- not just an alphabetical list,
    // so the crew's default choice is the actually-closest hospital.
    select.innerHTML = hospitals
      .map((h) => {
        const etaLabel =
          routingSource === 'osrm' && h.etaSeconds !== null
            ? `~${Math.round(h.etaSeconds / 60)} min`
            : `${(h.distanceMeters / 1000).toFixed(1)} km`;
        const label = h.diversionStatus === 'diversion'
          ? `${h.name} (${etaLabel}) -- ON DIVERSION`
          : `${h.name} (${etaLabel})`;
        return `<option value="${h.hospitalId}">${escapeHtml(label)}</option>`;
      })
      .join('');
    const errorBox = document.getElementById('route-error');
    // Ranked list already puts accepting hospitals first (see
    // dispatchService.rankHospitals) -- if the very first option is still
    // on diversion, every hospital is, and the crew needs to know that
    // before picking one, not discover it after transport starts.
    if (errorBox && hospitals.length > 0 && hospitals[0].diversionStatus === 'diversion') {
      errorBox.innerHTML = '<p class="error-banner">Every nearby hospital is currently on diversion -- confirm with dispatch before transporting.</p>';
    } else if (routingSource === 'haversine_fallback') {
      if (errorBox) errorBox.innerHTML = '<p class="error-banner">Road-routing unavailable -- hospital distances are straight-line estimates.</p>';
    }
  } catch (err) {
    const errorBox = document.getElementById('route-error');
    if (errorBox) errorBox.innerHTML = `<p class="error-banner">Could not load hospitals: ${escapeHtml(err.message)}</p>`;
  }
}

async function submitStatus(nextStatus, hospitalId) {
  const btn = document.getElementById('status-btn');
  btn.disabled = true;
  try {
    const { incident } = await apiPost(`/api/incidents/${currentIncident.id}/status`, {
      status: nextStatus,
      hospitalId,
    });
    if (nextStatus === 'closed') {
      currentIncident = null;
      renderWaitingState();
    } else {
      currentIncident = incident;
      renderMissionView();
    }
  } catch (err) {
    btn.disabled = false;
    const errorBox = document.getElementById('route-error');
    if (errorBox) errorBox.innerHTML = `<p class="error-banner">${escapeHtml(err.message)}</p>`;
  }
}

// --- GPS reporting -----------------------------------------------------

async function startGpsReporting() {
  if (watchId !== null) return; // already running
  await requestWakeLock();

  if (!('geolocation' in navigator)) {
    console.error('Geolocation not available in this browser');
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      const { latitude, longitude } = position.coords;
      if (socket && socket.connected) {
        socket.emit('ambulance:location', { lat: latitude, lng: longitude });
      }
      lastGpsAt = Date.now();
      updateGpsIndicator(true);
      // First fix after a mission starts is also the moment a route
      // becomes available (the route endpoint needs a known origin).
      if (currentIncident && !routeLayer) loadRoute();
    },
    (err) => {
      console.error('GPS error:', err.message);
      updateGpsIndicator(false);
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function stopGpsReporting() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  releaseWakeLock();
}

function updateGpsIndicator(active) {
  const dot = document.getElementById('gps-dot');
  const text = document.getElementById('gps-text');
  if (!dot || !text) return;
  dot.classList.toggle('off', !active);
  text.textContent = active ? `GPS reporting (last fix ${new Date(lastGpsAt).toLocaleTimeString()})` : 'GPS unavailable';
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch (err) {
    console.error('Wake Lock request failed:', err.message);
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// Re-acquire the wake lock if the tab regains visibility mid-mission --
// the OS/browser releases it automatically when the tab is backgrounded.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentIncident && !wakeLock) {
    requestWakeLock();
  }
});

init();
