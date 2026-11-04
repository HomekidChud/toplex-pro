/* Toplix Pro — native bridge.
 * One Promise-based API (window.ToplixNative) over the two native shells:
 *   - Electron preload  -> window.toplexNative
 *   - Capacitor/Android -> Capacitor.Plugins.ToplixNative
 * In a plain browser there is no native shell, so `available` is false.
 */
(function () {
  'use strict';
  var electron = window.toplexNative || null;
  var cap = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()
    ? (window.Capacitor.Plugins || {}).ToplixNative : null;

  var api = { available: false, shell: 'browser' };

  if (electron) {
    api = {
      available: true, shell: 'electron',
      loopbackStart: function (port) { return electron.loopbackStart(port); },
      loopbackWait: function () { return electron.loopbackWait(); },
      loopbackStop: function () { return electron.loopbackStop(); },
      http: function (o) { return electron.http(o); },
      secureGet: function (k) { return electron.secureGet(k); },
      secureSet: function (k, v) { return electron.secureSet(k, v); },
      secureRemove: function (k) { return electron.secureRemove(k); },
      openExternal: function (u) { return electron.openExternal(u); },
      detectApps: function () { return Promise.resolve({ chatgpt: false, claude: false }); },
      launchApp: function () { return Promise.reject(new Error('Not available on desktop')); }
    };
  } else if (cap) {
    api = {
      available: true, shell: 'android',
      loopbackStart: function (port) { return cap.loopbackStart({ port: port || 1455 }); },
      loopbackWait: function () { return cap.loopbackWait().then(function (r) { return r.url; }); },
      loopbackStop: function () { return cap.loopbackStop(); },
      http: function (o) { return cap.http(o); },
      secureGet: function (k) { return cap.secureGet({ key: k }).then(function (r) { return r.value; }); },
      secureSet: function (k, v) { return cap.secureSet({ key: k, value: v }); },
      secureRemove: function (k) { return cap.secureRemove({ key: k }); },
      openExternal: function (u) { return cap.openExternal({ url: u }); },
      detectApps: function () { return cap.detectApps(); },
      launchApp: function (app) { return cap.launchApp({ app: app }); }
    };
  }
  window.ToplixNative = api;
})();
