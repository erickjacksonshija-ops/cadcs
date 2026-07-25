// Thin fetch wrapper shared by all four frontends. Same-origin cookies are
// sent automatically by the browser for same-origin requests, but
// credentials:'include' is set explicitly rather than relying on default
// behavior, since default cross-origin credential handling has changed
// across browsers over the years.
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
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

  return data;
}

const apiGet = (path) => api('GET', path);
const apiPost = (path, body) => api('POST', path, body);

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
