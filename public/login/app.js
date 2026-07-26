const ROLE_HOME = {
  admin: '/admin/',
  dispatcher: '/dispatcher/',
  crew: '/crew/',
  hospital_staff: '/hospital/',
};

addPasswordToggle(document.getElementById('password'));

const form = document.getElementById('login-form');
const errorBox = document.getElementById('error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.style.display = 'none';
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  try {
    const { user } = await api('POST', '/api/auth/login', { email, password });
    window.location.href = ROLE_HOME[user.role] || '/';
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.style.display = 'block';
  }
});

// If already logged in, skip straight to the right dashboard. Uses a
// plain fetch (not the shared api() helper) because api() redirects to
// '/' on 401 -- which is exactly where we already are, so that
// redirect behavior would be redundant/wasteful on this specific page.
// Includes the Authorization header manually for the same reason api()
// needs it -- see shared/api.js.
const existingToken = sessionStorage.getItem('cadcs_token');
fetch('/api/auth/me', {
  credentials: 'include',
  headers: existingToken ? { Authorization: `Bearer ${existingToken}` } : undefined,
})
  .then((res) => (res.ok ? res.json() : null))
  .then((data) => {
    if (data) window.location.href = ROLE_HOME[data.user.role] || '/';
  })
  .catch(() => {});
