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

  await loadNotifications();
}

function initSocket() {
  socket = io();

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
    return `
      <div class="panel notification-card ${stateClass}">
        <div class="top-row">
          <span class="badge ${priorityBadge}">${n.priority}</span>
          <span class="eta-pill">${etaLabel(n.eta_snapshot_seconds)}</span>
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
