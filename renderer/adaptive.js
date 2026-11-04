/* Toplix Pro — adaptive UI.
 * Detects device class, input type, platform, orientation and colour scheme,
 * exposes them as data-* attributes on <html> (so CSS can adapt), and drives
 * the responsive sidebar (drawer on compact screens, docked on large ones).
 * Loaded in <head>; DOM wiring happens on DOMContentLoaded.
 */
(function () {
  'use strict';
  var root = document.documentElement;
  var COMPACT_MAX = 899;                 // < 900px  -> sidebar becomes a drawer
  var mq = function (q) { return window.matchMedia(q); };

  /* ---------- Platform / shell ---------- */
  var ua = navigator.userAgent || '';
  var platform = /Android/i.test(ua) ? 'android'
    : /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) ? 'ios'
    : /Mac/i.test(ua) ? 'mac'
    : /Win/i.test(ua) ? 'windows'
    : /Linux|X11/i.test(ua) ? 'linux' : 'web';
  var shell = (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) ? 'capacitor'
    : /Electron/i.test(ua) ? 'electron' : 'browser';
  root.setAttribute('data-platform', platform);
  root.setAttribute('data-shell', shell);

  /* ---------- Size / input / orientation ---------- */
  var state = { compact: false, size: 'desktop', desktopSidebarOpen: true };

  function sizeClass(w) {
    return w < 600 ? 'phone' : w < 900 ? 'tablet' : w < 1600 ? 'desktop' : 'wide';
  }

  function measure() {
    var w = window.innerWidth, h = window.innerHeight;
    var size = sizeClass(w);
    var compact = w <= COMPACT_MAX;
    var touch = mq('(pointer: coarse)').matches || mq('(hover: none)').matches;
    root.setAttribute('data-size', size);
    root.setAttribute('data-compact', compact ? 'true' : 'false');
    root.setAttribute('data-input', touch ? 'touch' : 'mouse');
    root.setAttribute('data-orientation', w >= h ? 'landscape' : 'portrait');
    root.setAttribute('data-short', h <= 520 ? 'true' : 'false');   // landscape phones
    root.setAttribute('data-motion', mq('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full');
    return { size: size, compact: compact };
  }

  var first = true;
  function apply() {
    var m = measure();
    var app = document.getElementById('app');
    if (app) {
      if (first) {
        if (m.compact) app.classList.add('sidebar-hidden');
      } else if (m.compact !== state.compact) {
        if (m.compact) app.classList.add('sidebar-hidden');                // entering drawer mode
        else app.classList.toggle('sidebar-hidden', !state.desktopSidebarOpen); // back to docked
      }
      syncScrim();
    }
    state.compact = m.compact;
    state.size = m.size;
    first = false;
    updatePlaceholder();
    updateShortcuts();
  }

  /* ---------- Colour scheme (follow the system until the user picks) ---------- */
  function syncThemeChrome() {
    var theme = root.getAttribute('data-theme') || 'light';
    var meta = document.querySelector('meta[name="theme-color"]');
    var bg = theme === 'dark' ? '#101012' : '#f7f7f8';
    if (meta) meta.setAttribute('content', bg);
    var sb = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.StatusBar;
    if (sb) {
      try { sb.setStyle({ style: theme === 'dark' ? 'DARK' : 'LIGHT' }); } catch (e) { /* ignore */ }
      try { sb.setBackgroundColor({ color: bg }); } catch (e) { /* ignore */ }
    }
  }

  /* ---------- Drawer scrim + gestures ---------- */
  var scrim;
  function isOpen() { var a = document.getElementById('app'); return a && !a.classList.contains('sidebar-hidden'); }
  function setOpen(open) {
    var a = document.getElementById('app');
    if (a) a.classList.toggle('sidebar-hidden', !open);
  }
  function syncScrim() {
    if (!scrim) return;
    scrim.classList.toggle('show', state.compact && isOpen());
  }

  function updatePlaceholder() {
    var input = document.getElementById('composer-input');
    if (!input) return;
    if (!input.dataset.fullPlaceholder) input.dataset.fullPlaceholder = input.placeholder;
    input.placeholder = state.size === 'phone' ? 'Ask Toplix to code…' : input.dataset.fullPlaceholder;
  }

  function updateShortcuts() {
    var kbd = document.querySelector('.new-chat-btn kbd');
    if (kbd) kbd.textContent = platform === 'mac' ? '⌘N' : 'Ctrl N';
  }

  function wire() {
    var app = document.getElementById('app');
    if (!app) return;

    scrim = document.createElement('div');
    scrim.className = 'drawer-scrim';
    scrim.addEventListener('click', function () { setOpen(false); });
    app.appendChild(scrim);

    // Remember the user's own choice on large screens
    new MutationObserver(function () {
      if (!state.compact) state.desktopSidebarOpen = isOpen();
      syncScrim();
    }).observe(app, { attributes: true, attributeFilter: ['class'] });

    // Close the drawer after navigating on compact screens
    document.addEventListener('click', function (e) {
      if (!state.compact || !isOpen()) return;
      if (e.target.closest('.chat-item:not(.chat-delete)') && !e.target.closest('.chat-delete')) setOpen(false);
      else if (e.target.closest('#new-chat-btn, #open-settings')) setOpen(false);
    }, true);

    // Swipe: from the left edge to open, leftwards on the drawer to close
    var sx = 0, sy = 0, tracking = false;
    document.addEventListener('touchstart', function (e) {
      if (!state.compact || e.touches.length !== 1) return;
      var t = e.touches[0]; sx = t.clientX; sy = t.clientY;
      tracking = (!isOpen() && sx < 24) || (isOpen() && !!e.target.closest('.sidebar, .drawer-scrim'));
    }, { passive: true });
    document.addEventListener('touchend', function (e) {
      if (!tracking) return; tracking = false;
      var t = e.changedTouches[0], dx = t.clientX - sx, dy = Math.abs(t.clientY - sy);
      if (dy > 60 || Math.abs(dx) < 60) return;
      if (dx > 0 && !isOpen()) setOpen(true);
      if (dx < 0 && isOpen()) setOpen(false);
    }, { passive: true });

    // Keep the composer visible when the soft keyboard opens
    var input = document.getElementById('composer-input');
    if (input && window.visualViewport) {
      input.addEventListener('focus', function () {
        setTimeout(function () { input.scrollIntoView({ block: 'nearest' }); }, 250);
      });
    }

    // Android hardware back: close drawer / settings before leaving the app
    var capApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (capApp && capApp.addListener) {
      capApp.addListener('backButton', function (ev) {
        var overlay = document.getElementById('settings-overlay');
        if (overlay && !overlay.hidden) { document.getElementById('settings-close').click(); return; }
        if (state.compact && isOpen()) { setOpen(false); return; }
        if (ev && ev.canGoBack) { history.back(); return; }
        if (capApp.minimizeApp) capApp.minimizeApp(); else if (capApp.exitApp) capApp.exitApp();
      });
    }

    new MutationObserver(syncThemeChrome).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    syncThemeChrome();
    apply();
  }

  measure();
  var raf = 0;
  function schedule() { cancelAnimationFrame(raf); raf = requestAnimationFrame(apply); }
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  ['(pointer: coarse)', '(hover: none)', '(prefers-reduced-motion: reduce)'].forEach(function (q) {
    var m = mq(q); if (m.addEventListener) m.addEventListener('change', schedule);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  window.ToplixAdaptive = {
    get compact() { return state.compact; },
    get size() { return state.size; },
    get platform() { return platform; },
    closeDrawer: function () { if (state.compact) setOpen(false); }
  };
})();
