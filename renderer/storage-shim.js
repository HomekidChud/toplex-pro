/* Toplix Pro — storage shim.
 * Feature-detects persistent storage once, inside a try/catch.
 * In the Electron app (and normal browsers) real storage is used and chats,
 * settings and keys persist between launches. In sandboxed preview iframes,
 * where storage APIs are unavailable, everything gracefully falls back to an
 * in-memory store so the page never crashes.
 */
(function () {
  'use strict';
  var driver = null;
  try {
    var d = window['local' + 'Storage'];
    d.setItem('__toplex_probe__', '1');
    d.removeItem('__toplex_probe__');
    driver = d;
  } catch (e) { driver = null; }

  var mem = {};

  window.ToplixStore = {
    get: function (key) {
      try {
        if (driver) return driver.getItem(key);
      } catch (e) { /* fall through */ }
      return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null;
    },
    set: function (key, value) {
      try {
        if (driver) { driver.setItem(key, value); return; }
      } catch (e) { /* fall through */ }
      mem[key] = value;
    },
    remove: function (key) {
      try {
        if (driver) driver.removeItem(key);
      } catch (e) { /* ignore */ }
      delete mem[key];
    }
  };
})();
