// CADCS Hospital Portal -- vanilla JS. Receives pre-notifications for
// incoming patients (with condition detail, per the role-aware serializer
// -- hospitals see more clinical detail than crew, since preparing a
// trauma bay needs it) and lets staff acknowledge receipt.

let currentUser = null;
let socket = null;
let notifications = new Map(); // notificationId -> notification

async function init() {
  try {
    const { user } = await apiGet('/api/auth/me');
    if (user.role !== 'hospital_staff') {
      window.location.href = '/';
      return;
    }
    currentUser = user;
    document.getElementById('user-name').textContent = user.name;
  } catch {
    return;
  }

  initSocket();
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await apiPost('/api/auth/logout');
    window.location.href = '/';
  });

  await initNotificationsButton();
  await renderDiversionBar();
  await loadNotifications();
  startEtaPolling();
}

// Self-reported capacity status (see plan: "Hospital diversion/capacity
// status") -- advisory, not a hard block: dispatchService.rankHospitals
// still lists this facility when it's on diversion, just sorted after
// accepting ones, so a crew can still override for a genuinely critical
// patient. This bar is the hospital side of that -- staff flip it when the
// ED is too full to safely take new patients.
async function renderDiversionBar() {
  const bar = document.getElementById('diversion-bar');
  if (!bar) return;
  let hospital;
  try {
    ({ hospital } = await apiGet('/api/hospitals/mine'));
  } catch (err) {
    bar.innerHTML = errorBannerHtml(err.message);
    return;
  }

  const isDiversion = hospital.diversion_status === 'diversion';
  bar.innerHTML = `
    <div class="panel diversion-bar ${isDiversion ? 'diversion' : 'accepting'}">
      <div>
        <strong>${hospital.name}</strong> is currently
        <strong>${isDiversion ? 'ON DIVERSION' : 'ACCEPTING'}</strong> patients.
        ${isDiversion && hospital.diversion_reason ? `<span class="muted"> &mdash; ${escapeHtml(hospital.diversion_reason)}</span>` : ''}
      </div>
      <div class="diversion-controls">
        ${isDiversion
          ? '<button id="set-accepting-btn">Mark accepting again</button>'
          : `<input id="diversion-reason-input" placeholder="Reason (optional)" />
             <button class="danger" id="set-diversion-btn">Go on diversion</button>`}
      </div>
    </div>
  `;

  const acceptBtn = document.getElementById('set-accepting-btn');
  if (acceptBtn) acceptBtn.addEventListener('click', () => setDiversionStatus('accepting'));

  const diversionBtn = document.getElementById('set-diversion-btn');
  if (diversionBtn) {
    diversionBtn.addEventListener('click', () => {
      const reason = document.getElementById('diversion-reason-input').value.trim();
      setDiversionStatus('diversion', reason);
    });
  }
}

function errorBannerHtml(message) {
  return `<div class="error-banner">${escapeHtml(message)}</div>`;
}

async function setDiversionStatus(status, reason) {
  try {
    await apiPost('/api/hospitals/mine/diversion-status', { status, reason: reason || undefined });
    await renderDiversionBar();
  } catch (err) {
    const bar = document.getElementById('diversion-bar');
    if (bar) bar.innerHTML += errorBannerHtml(err.message);
  }
}

// Recomputes each pending notification's ETA from the ambulance's current
// GPS position every 20s (see GET /api/hospital/notifications/:id/eta) --
// eta_snapshot_seconds is a one-time value taken when transport started, so
// without this the pill would sit frozen for the whole trip. Acknowledged
// notifications stop polling; the hospital has already acted on them.
const ETA_POLL_INTERVAL_MS = 20000;

function startEtaPolling() {
  setInterval(refreshLiveEtas, ETA_POLL_INTERVAL_MS);
}

async function refreshLiveEtas() {
  const pending = [...notifications.values()].filter((n) => !n.acknowledged_at);
  if (pending.length === 0) return;
  await Promise.all(pending.map(async (n) => {
    try {
      const { etaSeconds } = await apiGet(`/api/hospital/notifications/${n.id}/eta`);
      n.live_eta_seconds = etaSeconds;
    } catch {
      // leave whatever ETA was last known rather than blanking the pill
    }
  }));
  render();
}

// Web Push opt-in (see plan: "Notification Reliability") -- reaches this
// hospital account's staff even when the portal tab is backgrounded, on
// top of the Socket.IO push above which only works while it's focused.
const PUSH_SW_PATH = '/hospital/service-worker.js';

async function initNotificationsButton() {
  const btn = document.getElementById('notifications-btn');
  const enabled = await isPushEnabled(PUSH_SW_PATH);
  btn.textContent = enabled ? 'Notifications on' : 'Enable notifications';
  btn.disabled = enabled;

  const statusEl = document.getElementById('notifications-status');
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

function initSocket() {
  socket = io({ auth: { token: getToken() } });

  socket.on('hospital:notified', (payload) => {
    notifications.set(payload.notificationId, {
      id: payload.notificationId,
      incident_id: payload.incident.id,
      sent_at: new Date().toISOString(),
      eta_snapshot_seconds: payload.etaSeconds,
      acknowledged_at: null,
      escalated_at: null,
      priority: payload.incident.priority,
      required_capability: payload.incident.required_capability,
      chief_complaint: payload.incident.chief_complaint,
      location_description: payload.incident.location_description,
      patient_notes: payload.incident.patient_notes,
      status: payload.incident.status,
      ambulance_call_sign: payload.ambulanceCallSign,
      ambulance_capability_level: payload.ambulanceCapabilityLevel,
    });
    render();
    flashNewAlert();
  });

  socket.on('hospital:ack_escalated', ({ notificationId }) => {
    const n = notifications.get(notificationId);
    if (n) {
      n.escalated_at = new Date().toISOString();
      render();
    }
  });

  socket.on('connect_error', (err) => console.error('Socket connection failed:', err.message));
}

function flashNewAlert() {
  document.body.style.transition = 'none';
  document.body.style.backgroundColor = '#38bdf8';
  requestAnimationFrame(() => {
    document.body.style.transition = 'background-color 1.2s';
    document.body.style.backgroundColor = '';
  });
}

async function loadNotifications() {
  const { notifications: list } = await apiGet('/api/hospital/notifications');
  notifications.clear();
  list.forEach((n) => notifications.set(n.id, n));
  render();
}

function etaLabel(seconds) {
  if (seconds === null || seconds === undefined) return 'ETA unavailable';
  return `ETA ~${Math.round(seconds / 60)} min`;
}

function render() {
  const container = document.getElementById('app-content');
  const sorted = [...notifications.values()].sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));

  if (sorted.length === 0) {
    container.innerHTML = '<p class="muted">No incoming patients notified yet.</p>';
    return;
  }

  container.innerHTML = sorted.map((n) => {
    const stateClass = n.acknowledged_at ? 'acknowledged' : n.escalated_at ? 'escalated' : 'pending';
    const priorityBadge = n.priority === 'P1' ? 'badge-p1' : n.priority === 'P2' ? 'badge-p2' : 'badge-p3';
    const unitLabel = n.ambulance_call_sign
      ? `${escapeHtml(n.ambulance_call_sign)}${n.ambulance_capability_level ? ` &middot; ${escapeHtml(n.ambulance_capability_level)}` : ''}`
      : 'Unit inbound';
    // Trip-status-card layout (ambulance identity + live ETA up top, same
    // "who's coming and when" framing a ride-hailing trip card leads with)
    // rather than burying it below the clinical detail.
    return `
      <div class="panel notification-card ${stateClass}">
        <div class="top-row">
          <span class="badge ${priorityBadge}">${n.priority}</span>
          <span class="eta-pill">${etaLabel(n.live_eta_seconds !== undefined ? n.live_eta_seconds : n.eta_snapshot_seconds)}</span>
        </div>
        <div class="unit-row">
          <span class="unit-icon" aria-hidden="true">&#128657;</span>
          <span class="unit-label">${unitLabel}</span>
        </div>
        <h3 style="margin: 0.4rem 0;">${escapeHtml(n.chief_complaint)} <span class="muted">(${escapeHtml(n.required_capability)})</span></h3>
        <p class="muted">${escapeHtml(n.location_description) || ''}</p>
        ${n.patient_notes ? `<p>${escapeHtml(n.patient_notes)}</p>` : ''}
        <p class="muted">Sent ${new Date(n.sent_at).toLocaleTimeString()}</p>
        <div class="ack-status">
          ${n.acknowledged_at
            ? `<span class="muted">Acknowledged ${new Date(n.acknowledged_at).toLocaleTimeString()}</span>`
            : `<button data-id="${n.id}" class="ack-btn">Acknowledge</button>`}
          ${n.escalated_at && !n.acknowledged_at ? '<span class="error-banner" style="margin-top:0.4rem;display:block;">Escalated to dispatcher -- expect a phone call</span>' : ''}
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.ack-btn').forEach((btn) => {
    btn.addEventListener('click', () => acknowledgeNotification(Number(btn.dataset.id)));
  });
}

async function acknowledgeNotification(id) {
  try {
    const { notification } = await apiPost(`/api/hospital/notifications/${id}/acknowledge`);
    const existing = notifications.get(id);
    if (existing) {
      existing.acknowledged_at = notification.acknowledged_at;
      render();
    }
  } catch (err) {
    console.error('Acknowledge failed:', err.message);
  }
}

init();
