// CADCS Admin Panel -- vanilla JS. Back-office CRUD over the existing
// /api/admin/* endpoints (create + list; no edit/delete UI yet -- not
// needed for the FYP demo scope, and safer to add deliberately later
// than to bolt on destructive actions without a confirmation flow).

let currentUser = null;
let activeTab = 'providers';
let providersCache = []; // needed to populate the ambulance/user provider pickers

async function init() {
  try {
    const { user } = await apiGet('/api/auth/me');
    if (user.role !== 'admin') {
      window.location.href = '/';
      return;
    }
    currentUser = user;
    document.getElementById('user-name').textContent = user.name;
  } catch {
    return;
  }

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await apiPost('/api/auth/logout');
    window.location.href = '/';
  });

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  await refreshProvidersCache();
  await renderTab();
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  renderTab();
}

async function refreshProvidersCache() {
  const { providers } = await apiGet('/api/admin/providers');
  providersCache = providers;
}

async function renderTab() {
  const renderers = {
    providers: renderProviders,
    hospitals: renderHospitals,
    ambulances: renderAmbulances,
    users: renderUsers,
    analytics: renderAnalytics,
  };
  await renderers[activeTab]();
}

function errorBanner(message) {
  return `<div class="error-banner">${escapeHtml(message)}</div>`;
}

// --- Providers -----------------------------------------------------------

async function renderProviders() {
  const { providers } = await apiGet('/api/admin/providers');
  const container = document.getElementById('app-content');
  container.innerHTML = `
    <div class="admin-grid">
      <div class="panel">
        <div class="section-title" style="text-transform:uppercase;color:var(--color-text-dim);font-size:0.75rem;">New Provider</div>
        <div id="form-error"></div>
        <label for="p-name">Name</label>
        <input id="p-name" />
        <label for="p-type">Type</label>
        <select id="p-type">
          <option value="hospital_owned">Hospital-owned</option>
          <option value="private">Private</option>
          <option value="ngo">NGO</option>
        </select>
        <label for="p-phone">Contact phone</label>
        <input id="p-phone" />
        <button id="submit-btn">Create Provider</button>
      </div>
      <div class="panel">
        <table>
          <thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Active</th></tr></thead>
          <tbody>
            ${providers.map((p) => `<tr><td>${p.id}</td><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.type)}</td><td>${p.active ? 'Yes' : 'No'}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('submit-btn').addEventListener('click', async () => {
    const errorBox = document.getElementById('form-error');
    errorBox.innerHTML = '';
    try {
      await apiPost('/api/admin/providers', {
        name: document.getElementById('p-name').value,
        type: document.getElementById('p-type').value,
        contactPhone: document.getElementById('p-phone').value || undefined,
      });
      await refreshProvidersCache();
      await renderProviders();
    } catch (err) {
      errorBox.innerHTML = errorBanner(err.message);
    }
  });
}

// --- Hospitals -------------------------------------------------------------

async function renderHospitals() {
  const { hospitals } = await apiGet('/api/admin/hospitals');
  const container = document.getElementById('app-content');
  container.innerHTML = `
    <div class="admin-grid">
      <div class="panel">
        <div class="section-title" style="text-transform:uppercase;color:var(--color-text-dim);font-size:0.75rem;">New Hospital</div>
        <div id="form-error"></div>
        <label for="h-name">Name</label>
        <input id="h-name" />
        <div class="field-row">
          <div>
            <label for="h-lat">Latitude</label>
            <input id="h-lat" placeholder="-8.9094" />
          </div>
          <div>
            <label for="h-lng">Longitude</label>
            <input id="h-lng" placeholder="33.4607" />
          </div>
        </div>
        <label for="h-address">Address</label>
        <input id="h-address" />
        <label for="h-phone">Contact phone</label>
        <input id="h-phone" />
        <button id="submit-btn">Create Hospital</button>
      </div>
      <div class="panel">
        <table>
          <thead><tr><th>ID</th><th>Name</th><th>Location</th><th>Address</th></tr></thead>
          <tbody>
            ${hospitals.map((h) => `<tr><td>${h.id}</td><td>${escapeHtml(h.name)}</td><td>${h.lat.toFixed(4)}, ${h.lng.toFixed(4)}</td><td>${escapeHtml(h.address) || ''}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('submit-btn').addEventListener('click', async () => {
    const errorBox = document.getElementById('form-error');
    errorBox.innerHTML = '';
    try {
      await apiPost('/api/admin/hospitals', {
        name: document.getElementById('h-name').value,
        lat: Number(document.getElementById('h-lat').value),
        lng: Number(document.getElementById('h-lng').value),
        address: document.getElementById('h-address').value || undefined,
        contactPhone: document.getElementById('h-phone').value || undefined,
      });
      await renderHospitals();
    } catch (err) {
      errorBox.innerHTML = errorBanner(err.message);
    }
  });
}

// --- Ambulances --------------------------------------------------------

async function renderAmbulances() {
  const { ambulances } = await apiGet('/api/admin/ambulances');
  const container = document.getElementById('app-content');
  const providerOptions = providersCache.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

  container.innerHTML = `
    <div class="admin-grid">
      <div class="panel">
        <div class="section-title" style="text-transform:uppercase;color:var(--color-text-dim);font-size:0.75rem;">New Ambulance</div>
        <div id="form-error"></div>
        <label for="a-provider">Provider</label>
        <select id="a-provider">${providerOptions}</select>
        <label for="a-callsign">Call sign</label>
        <input id="a-callsign" placeholder="MB-01" />
        <label for="a-capability">Capability</label>
        <select id="a-capability">
          <option value="BLS">BLS</option>
          <option value="ALS">ALS</option>
        </select>
        <button id="submit-btn">Create Ambulance</button>
      </div>
      <div class="panel">
        <table>
          <thead><tr><th>ID</th><th>Call sign</th><th>Capability</th><th>Status</th><th>Provider</th></tr></thead>
          <tbody>
            ${ambulances.map((a) => `<tr><td>${a.id}</td><td>${escapeHtml(a.call_sign)}</td><td>${a.capability_level}</td><td>${a.status}</td><td>${escapeHtml(providerName(a.provider_id))}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('submit-btn').addEventListener('click', async () => {
    const errorBox = document.getElementById('form-error');
    errorBox.innerHTML = '';
    try {
      await apiPost('/api/admin/ambulances', {
        providerId: Number(document.getElementById('a-provider').value),
        callSign: document.getElementById('a-callsign').value,
        capabilityLevel: document.getElementById('a-capability').value,
      });
      await renderAmbulances();
    } catch (err) {
      errorBox.innerHTML = errorBanner(err.message);
    }
  });
}

function providerName(id) {
  const p = providersCache.find((p) => p.id === id);
  return p ? p.name : `#${id}`;
}

// --- Users ---------------------------------------------------------------

async function renderUsers() {
  const { users } = await apiGet('/api/admin/users');
  const { hospitals } = await apiGet('/api/admin/hospitals');
  const container = document.getElementById('app-content');
  const providerOptions = providersCache.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  const hospitalOptions = hospitals.map((h) => `<option value="${h.id}">${escapeHtml(h.name)}</option>`).join('');

  container.innerHTML = `
    <div class="admin-grid">
      <div class="panel">
        <div class="section-title" style="text-transform:uppercase;color:var(--color-text-dim);font-size:0.75rem;">New User</div>
        <div id="form-error"></div>
        <label for="u-name">Name</label>
        <input id="u-name" />
        <label for="u-email">Email</label>
        <input id="u-email" type="email" />
        <label for="u-password">Password</label>
        <input id="u-password" type="password" />
        <label for="u-role">Role</label>
        <select id="u-role">
          <option value="dispatcher">Dispatcher</option>
          <option value="crew">Crew</option>
          <option value="hospital_staff">Hospital Staff</option>
          <option value="admin">Admin</option>
        </select>
        <div id="u-provider-wrap">
          <label for="u-provider">Provider</label>
          <select id="u-provider">${providerOptions}</select>
        </div>
        <div id="u-hospital-wrap" style="display:none;">
          <label for="u-hospital">Hospital</label>
          <select id="u-hospital">${hospitalOptions}</select>
        </div>
        <button id="submit-btn">Create User</button>
      </div>
      <div class="panel">
        <table>
          <thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>
          <tbody>
            ${users.map((u) => `
              <tr>
                <td>${u.id}</td><td>${escapeHtml(u.name)}</td><td>${escapeHtml(u.email)}</td><td>${u.role}</td>
                <td><button class="secondary reset-pw-btn" data-id="${u.id}" data-name="${escapeHtml(u.name)}">Reset password</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  addPasswordToggle(document.getElementById('u-password'));

  document.querySelectorAll('.reset-pw-btn').forEach((btn) => {
    btn.addEventListener('click', () => openResetPasswordDialog(btn.dataset.id, btn.dataset.name));
  });

  const roleSelect = document.getElementById('u-role');
  const providerWrap = document.getElementById('u-provider-wrap');
  const hospitalWrap = document.getElementById('u-hospital-wrap');

  function syncFieldsToRole() {
    const role = roleSelect.value;
    providerWrap.style.display = role === 'dispatcher' || role === 'crew' ? '' : 'none';
    hospitalWrap.style.display = role === 'hospital_staff' ? '' : 'none';
  }
  roleSelect.addEventListener('change', syncFieldsToRole);
  syncFieldsToRole();

  document.getElementById('submit-btn').addEventListener('click', async () => {
    const errorBox = document.getElementById('form-error');
    errorBox.innerHTML = '';
    const role = roleSelect.value;
    try {
      await apiPost('/api/admin/users', {
        name: document.getElementById('u-name').value,
        email: document.getElementById('u-email').value,
        password: document.getElementById('u-password').value,
        role,
        providerId: role === 'dispatcher' || role === 'crew'
          ? Number(document.getElementById('u-provider').value)
          : undefined,
        hospitalId: role === 'hospital_staff'
          ? Number(document.getElementById('u-hospital').value)
          : undefined,
      });
      await renderUsers();
    } catch (err) {
      errorBox.innerHTML = errorBanner(err.message);
    }
  });
}

// --- Password reset (admin-mediated -- see userService.setPassword) -----

function openResetPasswordDialog(userId, userName) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:100;';
  overlay.innerHTML = `
    <div class="panel" style="width:320px;">
      <div class="section-title" style="text-transform:uppercase;color:var(--color-text-dim);font-size:0.75rem;">Reset password for ${escapeHtml(userName)}</div>
      <div id="reset-pw-error"></div>
      <label for="reset-pw-input">New password (min 8 characters)</label>
      <input id="reset-pw-input" type="password" />
      <div style="display:flex; gap:0.5rem; margin-top:0.75rem;">
        <button class="secondary" id="reset-pw-cancel" style="flex:1;">Cancel</button>
        <button id="reset-pw-confirm" style="flex:1;">Set new password</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = document.getElementById('reset-pw-input');
  addPasswordToggle(input);
  input.focus();

  document.getElementById('reset-pw-cancel').addEventListener('click', () => overlay.remove());

  document.getElementById('reset-pw-confirm').addEventListener('click', async () => {
    const errorBox = document.getElementById('reset-pw-error');
    errorBox.innerHTML = '';
    try {
      await apiPost(`/api/admin/users/${userId}/reset-password`, { newPassword: input.value });
      overlay.remove();
    } catch (err) {
      errorBox.innerHTML = errorBanner(err.message);
    }
  });
}

// --- Analytics -----------------------------------------------------------

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '--';
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${minutes}m ${rem}s`;
}

function renderBarBreakdown(title, dataObj) {
  const entries = Object.entries(dataObj);
  const max = Math.max(1, ...entries.map(([, count]) => count));
  return `
    <div class="panel" style="margin-top:1rem;">
      <div class="section-title" style="text-transform:uppercase;color:var(--color-text-dim);font-size:0.75rem;">${title}</div>
      ${entries.length === 0 ? '<p class="muted">No data yet.</p>' : entries.map(([label, count]) => `
        <div class="bar-row">
          <div class="bar-label">${escapeHtml(label)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(count / max) * 100}%"></div></div>
          <div class="bar-count">${count}</div>
        </div>
      `).join('')}
    </div>
  `;
}

async function renderAnalytics() {
  const summary = await apiGet('/api/admin/analytics');
  const container = document.getElementById('app-content');

  const benchmarkClass = summary.benchmarkMet.percent === null
    ? ''
    : summary.benchmarkMet.percent >= 80 ? 'good' : summary.benchmarkMet.percent < 50 ? 'bad' : '';

  container.innerHTML = `
    <div class="stat-grid">
      <div class="panel stat-tile">
        <div class="value">${summary.totalClosedIncidents}</div>
        <div class="label">Closed incidents</div>
      </div>
      <div class="panel stat-tile ${benchmarkClass}">
        <div class="value">${summary.benchmarkMet.percent === null ? '--' : summary.benchmarkMet.percent + '%'}</div>
        <div class="label">Met ${Math.round(summary.responseTimeBenchmarkSeconds / 60)}-min WHO benchmark (${summary.benchmarkMet.count}/${summary.benchmarkMet.total})</div>
      </div>
      <div class="panel stat-tile">
        <div class="value">${formatDuration(summary.callToScene.medianSeconds)}</div>
        <div class="label">Median call-to-scene</div>
      </div>
      <div class="panel stat-tile">
        <div class="value">${formatDuration(summary.callToScene.p95Seconds)}</div>
        <div class="label">P95 call-to-scene</div>
      </div>
      <div class="panel stat-tile ${summary.hospitalAcknowledgment.escalated > 0 ? 'bad' : ''}">
        <div class="value">${summary.hospitalAcknowledgment.pending}</div>
        <div class="label">Pending hospital acks (${summary.hospitalAcknowledgment.escalated} escalated)</div>
      </div>
    </div>

    <div class="panel">
      <div class="section-title" style="text-transform:uppercase;color:var(--color-text-dim);font-size:0.75rem;">Phase breakdown (mean / median / P95)</div>
      <table>
        <thead><tr><th>Phase</th><th>Mean</th><th>Median</th><th>P95</th><th>N</th></tr></thead>
        <tbody>
          <tr><td>Call to dispatch</td><td>${formatDuration(summary.callToDispatch.meanSeconds)}</td><td>${formatDuration(summary.callToDispatch.medianSeconds)}</td><td>${formatDuration(summary.callToDispatch.p95Seconds)}</td><td>${summary.callToDispatch.count}</td></tr>
          <tr><td>Call to scene (WHO benchmark)</td><td>${formatDuration(summary.callToScene.meanSeconds)}</td><td>${formatDuration(summary.callToScene.medianSeconds)}</td><td>${formatDuration(summary.callToScene.p95Seconds)}</td><td>${summary.callToScene.count}</td></tr>
          <tr><td>Scene to hospital</td><td>${formatDuration(summary.sceneToHospital.meanSeconds)}</td><td>${formatDuration(summary.sceneToHospital.medianSeconds)}</td><td>${formatDuration(summary.sceneToHospital.p95Seconds)}</td><td>${summary.sceneToHospital.count}</td></tr>
        </tbody>
      </table>
    </div>

    ${renderBarBreakdown('Incident volume by priority', summary.volumeByPriority)}
    ${renderBarBreakdown('Incident volume by provider', summary.volumeByProvider)}
    ${renderBarBreakdown('Incident volume by hour of day', summary.volumeByHour)}
  `;
}

init();
