// Thin fetch wrapper shared by all four frontends. Same-origin cookies are
// sent automatically by the browser for same-origin requests, but
// credentials:'include' is set explicitly rather than relying on default
// behavior, since default cross-origin credential handling has changed
// across browsers over the years.
// Cookie auth is the primary path and needs nothing here (credentials:
// 'include' below covers it). This token is a same-security-model fallback
// for hosting environments that never deliver the session cookie to the
// browser at all -- verified: GitHub Codespaces' port-forwarding relay
// strips Set-Cookie from the origin app entirely, in both public and
// private modes. sessionStorage (not localStorage) so it doesn't outlive
// the tab and isn't shared across tabs. See src/services/sessionTokenService.js
// for the server side.
const TOKEN_KEY = 'cadcs_token';
const getToken = () => sessionStorage.getItem(TOKEN_KEY);
const clearToken = () => sessionStorage.removeItem(TOKEN_KEY);

async function api(method, path, body) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    clearToken();
    window.location.href = '/';
    throw new Error('Not authenticated');
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // no JSON body (e.g. 204 No Content)
  }

  if (!res.ok) {
    const message = (data && data.error) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.details = data && data.details;
    throw err;
  }

  if (path === '/api/auth/login' && data && data.token) {
    sessionStorage.setItem(TOKEN_KEY, data.token);
  } else if (path === '/api/auth/logout') {
    clearToken();
  }

  return data;
}

const apiGet = (path) => api('GET', path);
const apiPost = (path, body) => api('POST', path, body);
const apiPatch = (path, body) => api('PATCH', path, body);

// Every frontend renders via innerHTML template literals for simplicity
// (no framework, matching the project's stack decision) -- which means
// any free-text field interpolated directly into one of those templates
// (patient notes, location descriptions, provider/hospital/user names,
// cancellation reasons, server error messages) is a stored-XSS vector:
// dispatchers, crew, and hospital staff all view data typed in by OTHER
// authenticated users (or admins), so a malicious or compromised account
// could inject a script that runs in someone else's session. This must
// wrap every such value before it goes into an innerHTML string -- values
// that are enums/numbers validated server-side (status, priority,
// capability level, ids) don't strictly need it, but escaping is applied
// consistently rather than requiring each call site to correctly judge
// "is this one safe" every time.
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
