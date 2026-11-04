/* Toplix Pro — Electron main process */
const { app, BrowserWindow, shell, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

let win = null;

const PROTOCOL = 'toplex';

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#f7f7f8',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
      : { autoHideMenuBar: true }),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => win.show());

  // Open external links in the default browser, never in-app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

/* ---------- Magic-link auth (custom toplex:// protocol) ---------- */

// The sign-in flow opens a magic link in the browser; after the user signs
// in on the provider's website, the browser redirects to
// toplex://auth/callback?... and macOS hands the URL back to this app.
function handleAuthUrl(url) {
  if (!win) return;
  if (url.startsWith(PROTOCOL + '://')) {
    win.webContents.send('auth-callback', url);
  }
}

app.whenReady().then(() => {
  app.setAsDefaultProtocolClient(PROTOCOL);

  // macOS: the OS delivers the URL through open-url
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleAuthUrl(url);
  });

  createWindow();

  // Windows/Linux: a second launch hands us the URL via argv
  const fromArgv = process.argv.find((a) => a.startsWith(PROTOCOL + '://'));
  if (fromArgv) handleAuthUrl(fromArgv);
});

app.on('second-instance', (event, argv) => {
  const url = argv.find((a) => a.startsWith(PROTOCOL + '://'));
  if (url) handleAuthUrl(url);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// Ask for a single instance lock so second-instance works for auth callbacks
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Renderer asks the OS browser to open the magic link
ipcMain.handle('open-magic-link', (event, url) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) {
    return shell.openExternal(url);
  }
  return Promise.reject(new Error('Only https magic links can be opened'));
});

/* ---------- Native bridge for Sign in with ChatGPT ---------- */

// 1) Loopback listener (OpenAI redirects the browser to http://127.0.0.1:<port>/auth/callback)
let loopback = null;   // { server, port, resolve, reject, url, timer }

function closeLoopback() {
  if (!loopback) return;
  clearTimeout(loopback.timer);
  try { loopback.server.close(); } catch (e) { /* ignore */ }
  loopback = null;
}

function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
  });
}

ipcMain.handle('native:loopback-start', async (event, preferred) => {
  closeLoopback();
  const state = { url: null, resolve: null, reject: null, timer: null };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/auth/callback') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Toplix Pro</title>'
      + '<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f7f7f8;color:#111827">'
      + '<div style="text-align:center"><h2>You can close this tab</h2><p>Return to Toplix Pro to continue.</p></div></body>');
    const full = 'http://127.0.0.1:' + server.address().port + req.url;
    state.url = full;
    if (state.resolve) state.resolve(full);
  });
  let port;
  try { port = await listenOn(server, Number(preferred) || 1455); }
  catch (e) { port = await listenOn(server, 0); }
  state.server = server; state.port = port;
  state.timer = setTimeout(() => { if (state.reject) state.reject(new Error('Sign-in timed out')); closeLoopback(); }, 5 * 60 * 1000);
  loopback = state;
  return { port };
});

ipcMain.handle('native:loopback-wait', () => new Promise((resolve, reject) => {
  if (!loopback) return reject(new Error('No sign-in in progress'));
  if (loopback.url) return resolve(loopback.url);
  loopback.resolve = resolve; loopback.reject = reject;
}));

ipcMain.handle('native:loopback-stop', () => { closeLoopback(); return true; });

// 2) HTTP from the main process (the token endpoint is not CORS-enabled for apps)
const HTTP_ALLOWED_HOSTS = new Set(['auth.openai.com', 'api.openai.com']);
ipcMain.handle('native:http', async (event, opts) => {
  const u = new URL(opts.url);
  if (u.protocol !== 'https:' || !HTTP_ALLOWED_HOSTS.has(u.hostname)) throw new Error('Host not allowed');
  const res = await fetch(opts.url, { method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
  return { status: res.status, text: await res.text() };
});

// 3) Encrypted credential storage (OS keychain via safeStorage)
function secureFile() { return path.join(app.getPath('userData'), 'secure.json'); }
function readSecure() { try { return JSON.parse(fs.readFileSync(secureFile(), 'utf8')); } catch (e) { return {}; } }
function writeSecure(obj) {
  const tmp = secureFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, secureFile());
}
ipcMain.handle('native:secure-set', (event, key, value) => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this system');
  const all = readSecure();
  all[key] = safeStorage.encryptString(String(value)).toString('base64');
  writeSecure(all);
  return true;
});
ipcMain.handle('native:secure-get', (event, key) => {
  const all = readSecure();
  if (!all[key] || !safeStorage.isEncryptionAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(all[key], 'base64')); } catch (e) { return null; }
});
ipcMain.handle('native:secure-remove', (event, key) => {
  const all = readSecure(); delete all[key]; writeSecure(all); return true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
