/* Toplix Pro — preload (contextIsolation bridge) */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toplex', {
  isDesktop: true,
  // Open the magic-link sign-in page in the user's default browser
  openMagicLink: (url) => ipcRenderer.invoke('open-magic-link', url),
  // Fired when the browser redirects back to toplex://auth/callback?...
  onAuthCallback: (handler) => ipcRenderer.on('auth-callback', (event, url) => handler(url))
});

// Native helpers used by Sign in with ChatGPT (loopback callback, HTTP, secure storage)
contextBridge.exposeInMainWorld('toplexNative', {
  loopbackStart: (port) => ipcRenderer.invoke('native:loopback-start', port),
  loopbackWait: () => ipcRenderer.invoke('native:loopback-wait'),
  loopbackStop: () => ipcRenderer.invoke('native:loopback-stop'),
  http: (opts) => ipcRenderer.invoke('native:http', opts),
  secureGet: (key) => ipcRenderer.invoke('native:secure-get', key),
  secureSet: (key, value) => ipcRenderer.invoke('native:secure-set', key, value),
  secureRemove: (key) => ipcRenderer.invoke('native:secure-remove', key),
  openExternal: (url) => ipcRenderer.invoke('open-magic-link', url)
});
