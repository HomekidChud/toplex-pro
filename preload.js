/* Toplix Pro — preload (contextIsolation bridge) */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toplex', {
  isDesktop: true,
  // Open the magic-link sign-in page in the user's default browser
  openMagicLink: (url) => ipcRenderer.invoke('open-magic-link', url),
  // Fired when the browser redirects back to toplex://auth/callback?...
  onAuthCallback: (handler) => ipcRenderer.on('auth-callback', (event, url) => handler(url))
});
