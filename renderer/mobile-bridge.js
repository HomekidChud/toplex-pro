/* Toplix Pro — mobile bridge.
 * When running inside the Capacitor (Android) shell, expose the same
 * window.toplex API the desktop preload provides, so the toplex:// magic-link
 * sign-in works on phones too. Does nothing on desktop or in a browser.
 */
(function () {
  'use strict';
  var cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform() || window.toplex) return;
  var plugins = cap.Plugins || {};
  window.toplex = {
    isDesktop: false,
    isMobile: true,
    openMagicLink: function (url) {
      if (!/^https:\/\//.test(url)) return Promise.reject(new Error('Only https magic links can be opened'));
      if (plugins.Browser) return plugins.Browser.open({ url: url });
      window.open(url, '_blank');
      return Promise.resolve();
    },
    onAuthCallback: function (handler) {
      if (!plugins.App) return;
      plugins.App.addListener('appUrlOpen', function (event) {
        if (event && event.url && event.url.indexOf('toplex://') === 0) {
          if (plugins.Browser) { try { plugins.Browser.close(); } catch (e) { /* ignore */ } }
          handler(event.url);
        }
      });
    }
  };
})();
