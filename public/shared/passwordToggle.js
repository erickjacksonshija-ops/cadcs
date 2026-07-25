// Wraps a password <input> with an eye-icon Show/Hide toggle, so a user
// can verify what they actually typed before submitting -- reduces
// failed-login frustration from typos, which is worth more than it costs
// given this system has no self-service "forgot password" flow (see the
// plan: account resets are admin-mediated, not email-based).
const EYE_OPEN_SVG = `
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path>
    <circle cx="12" cy="12" r="3"></circle>
  </svg>`;
const EYE_CLOSED_SVG = `
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a20.6 20.6 0 0 1 5.06-6.06M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a20.6 20.6 0 0 1-3.22 4.44"></path>
    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"></path>
    <line x1="1" y1="1" x2="23" y2="23"></line>
  </svg>`;

function addPasswordToggle(input) {
  const wrapper = document.createElement('div');
  wrapper.style.position = 'relative';
  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);

  input.style.paddingRight = '2.4rem';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Show password');
  toggle.innerHTML = EYE_OPEN_SVG;
  // top:0/bottom:0 + margin:auto is a deliberately chosen vertical-centering
  // technique for an absolutely positioned element -- top:50% +
  // translateY(-50%) was tried first and measured (via
  // getBoundingClientRect, not just eyeballed) to place the button's top
  // edge at the wrapper's midpoint rather than centering it, pushing the
  // bottom half outside the input. This approach doesn't depend on that
  // percentage-of-parent-height + transform interaction at all.
  toggle.style.cssText = `
    position: absolute; right: 0.35rem; top: 0; bottom: 0; margin: auto 0;
    width: 1.9rem; height: 1.9rem; padding: 0; display: flex; align-items: center; justify-content: center;
    background: transparent; border: none; color: var(--color-text-dim); cursor: pointer; border-radius: 4px;
  `;
  toggle.addEventListener('mouseenter', () => { toggle.style.color = 'var(--color-text)'; });
  toggle.addEventListener('mouseleave', () => { toggle.style.color = 'var(--color-text-dim)'; });
  wrapper.appendChild(toggle);

  toggle.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    toggle.innerHTML = showing ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
    toggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  });

  return toggle;
}
