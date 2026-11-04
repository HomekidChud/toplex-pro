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

// Computer Use (sandboxed agent mode). All safety rules live in the main
// process — the renderer can only ask, never relax them.
contextBridge.exposeInMainWorld('toplexComputer', {
  status: () => ipcRenderer.invoke('computer:status'),
  setEnabled: (on) => ipcRenderer.invoke('computer:set-enabled', on),
  setApprovalMode: (mode) => ipcRenderer.invoke('computer:set-approval-mode', mode),
  setFullAccess: (on) => ipcRenderer.invoke('computer:set-full-access', on),
  addRoot: () => ipcRenderer.invoke('computer:add-root'),
  removeRoot: (root) => ipcRenderer.invoke('computer:remove-root', root),
  log: () => ipcRenderer.invoke('computer:log'),
  call: (tool, args) => ipcRenderer.invoke('computer:call', tool, args)
});

// Installed desktop apps (ChatGPT with Cowork, Claude 2.0) — presence check only
contextBridge.exposeInMainWorld('toplexApps', {
  detect: () => ipcRenderer.invoke('apps:detect'),
  launch: (name) => ipcRenderer.invoke('apps:launch', name)
});
