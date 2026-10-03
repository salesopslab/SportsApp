// Show/hide ("eye") button for every password field on the page: log in,
// sign up, change password, and the admin key. Self-contained so the app,
// admin and usage pages can all include it with one <script> tag.
(function(){
  const EYE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  const style = document.createElement('style');
  style.textContent = `
    .pw-wrap{ position:relative; display:block; width:100%; }
    .pw-wrap > input{ padding-right:46px !important; }
    .pw-wrap > .pw-eye{ position:absolute; top:0; right:2px; bottom:0; width:42px !important; height:auto !important; margin:0 !important;
      display:flex; align-items:center; justify-content:center; background:none !important; border:none !important;
      padding:0 !important; cursor:pointer; color:var(--sub, #6b7280) !important; border-radius:8px; box-shadow:none !important; }
    .pw-wrap > .pw-eye:hover{ color:var(--text, #111) !important; }
    .pw-eye:focus-visible{ outline:2px solid var(--amber, #C77F1D); outline-offset:-4px; }
  `;
  document.head.appendChild(style);

  function setShown(input, btn, shown){
    input.type = shown ? 'text' : 'password';
    btn.innerHTML = shown ? EYE_OFF : EYE;
    btn.setAttribute('aria-pressed', String(shown));
    btn.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
    btn.title = shown ? 'Hide password' : 'Show password';
  }

  function enhance(input){
    if(input.dataset.pwEye) return;
    input.dataset.pwEye = '1';
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    // The input's bottom margin moves to the wrapper so the eye stays
    // vertically centred on the field itself.
    const mb = getComputedStyle(input).marginBottom;
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    wrap.style.marginBottom = mb;
    input.style.marginBottom = '0';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-eye';
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus (and the cursor) in the field
    btn.addEventListener('click', () => setShown(input, btn, input.type === 'password'));
    wrap.appendChild(btn);
    setShown(input, btn, false);
  }

  function enhanceAll(){ document.querySelectorAll('input[type="password"]').forEach(enhance); }

  // Back to hidden — called when a login/signup form is reopened.
  window.resetPasswordToggles = function(){
    document.querySelectorAll('.pw-wrap').forEach(w => {
      const input = w.querySelector('input'), btn = w.querySelector('.pw-eye');
      if(input && btn) setShown(input, btn, false);
    });
  };

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enhanceAll);
  else enhanceAll();
})();
