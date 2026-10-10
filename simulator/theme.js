/* MRISafe Twin theme switch: dark (default) or light, shared by the shell and both modules.
 * The choice is stored in this browser only (localStorage). Other same-origin frames pick it
 * up through the storage event, and every page listens for the 'mrisafe-theme' event so
 * the 3D scene can repaint its background. */
(function () {
  const KEY = 'mrisafe-theme';
  const root = document.documentElement;

  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function save(v) {
    try { localStorage.setItem(KEY, v); } catch (e) { /* storage blocked: theme still applies for this page */ }
  }
  function current() { return stored() === 'light' ? 'light' : 'dark'; }

  function paintButtons(v) {
    document.querySelectorAll('[data-theme-toggle]').forEach(b => {
      b.textContent = v === 'dark' ? 'Light' : 'Dark';
      b.setAttribute('aria-pressed', String(v === 'light'));
      b.title = v === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme';
    });
  }

  function apply(v) {
    root.setAttribute('data-theme', v);
    root.style.colorScheme = v;
    paintButtons(v);
    window.dispatchEvent(new CustomEvent('mrisafe-theme', { detail: v }));
  }

  function set(v) { save(v); apply(v); }
  function toggle() { set(current() === 'dark' ? 'light' : 'dark'); }

  window.MRITheme = { get: current, set, toggle };
  apply(current());
  document.addEventListener('DOMContentLoaded', () => paintButtons(current()));
  window.addEventListener('storage', e => { if (e.key === KEY) apply(current()); });
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-theme-toggle]');
    if (b) toggle();
  });
})();
