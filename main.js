/* Toplix Pro — Electron main process */
const { app, BrowserWindow, shell, ipcMain, safeStorage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

let win = null;

const PROTOCOL = 'toplex';

/* Ask for the single-instance lock FIRST, before anything else can run,
   so a second launch (e.g. a toplex:// link on Windows/Linux) hands the
   URL to the already-running instance and quits cleanly. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {

app.on('second-instance', (event, argv) => {
  const url = argv.find((a) => a.startsWith(PROTOCOL + '://'));
  if (url) queueAuthUrl(url);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

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

  rendererReady = false;
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => win.show());

  // Only hand URLs to the renderer once it can actually receive them
  win.webContents.once('did-finish-load', () => { rendererReady = true; flushAuthQueue(); });

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
// toplex://auth/callback?... and the OS hands the URL back to this app.
// URLs can arrive before the window/renderer exists (macOS open-url at
// launch), so they are queued and delivered once the page is ready.
let authQueue = [];
let rendererReady = false;

function queueAuthUrl(url) {
  if (typeof url === 'string' && url.startsWith(PROTOCOL + '://')) authQueue.push(url);
  flushAuthQueue();
}

function flushAuthQueue() {
  if (!win || !rendererReady) return;
  while (authQueue.length) {
    win.webContents.send('auth-callback', authQueue.shift());
  }
}

function handleAuthUrl(url) { queueAuthUrl(url); }

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

app.on('window-all-closed', () => {
  rendererReady = false;
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    rendererReady = false;
    createWindow();
  }
});

/* Renderer asks the OS browser to open the magic link */
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
    clearTimeout(state.timer);
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
  return { status: res.status, text: await res.text(), date: res.headers.get('date') || undefined };
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

/* ---------- Computer Use (desktop agent mode, heavily sandboxed) ----------
 *
 * Strict rules enforced by the main process — the renderer cannot relax them:
 *   1. File access is limited to folders the user explicitly approved
 *      (chosen with a native folder picker) — unless "full computer access"
 *      is switched on by the user, in which case any folder is reachable.
 *   2. Credentials and secrets are always off-limits: SSH/GPG/AWS keys,
 *      keychains, .env files, tokens and this app's own data folder.
 *   3. Every file write and every command is shown to the user in a native
 *      approval dialog and only runs if they click Allow. The user can also
 *      pick "Approve for me" (auto mode) so the AI can work without stopping —
 *      they can switch back to manual any time.
 *   4. Commands never run elevated (sudo/doas blocked), destructive and
 *      self-hiding patterns are blocked outright, and every command is
 *      killed after 60 seconds with its output capped.
 *   5. Everything the AI does is written to an audit log on this device.
 *   6. The AI also gets its own Chromium browser (the "AI Browser") and its
 *      own visible mouse cursor. The cursor lives inside the AI Browser and
 *      on the pages it opens — it never moves the user's real mouse.
 */

const CU_FILE = () => path.join(app.getPath('userData'), 'computer-use.json');
const CU_LOG = () => path.join(app.getPath('userData'), 'computer-use-log.json');
const CU_MAX_LOG = 300;

function cuConfig() {
  try { return JSON.parse(fs.readFileSync(CU_FILE(), 'utf8')); } catch (e) { return {}; }
}
function cuWrite(cfg) {
  fs.writeFileSync(CU_FILE(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
function cuLog(entry) {
  let log = [];
  try { log = JSON.parse(fs.readFileSync(CU_LOG(), 'utf8')); } catch (e) { log = []; }
  log.push(Object.assign({ t: new Date().toISOString() }, entry));
  try { fs.writeFileSync(CU_LOG(), JSON.stringify(log.slice(-CU_MAX_LOG), null, 1), { mode: 0o600 }); } catch (e) { /* ignore */ }
}

// Names/dirs that are never accessible, whatever the user approved.
function cuProtectedDirs() {
  const home = app.getPath('home');
  const dirs = ['.ssh', '.gnupg', '.config' + path.sep + 'gnupg', '.aws', '.kube', '.docker', '.config' + path.sep + 'sops'];
  const out = dirs.map((d) => path.join(home, d));
  out.push(path.join(home, 'Library', 'Keychains'));            // macOS keychains
  out.push(path.join(home, 'Library', 'Application Support', 'Google', 'Chrome')); // saved passwords/profiles
  out.push(app.getPath('userData'));                           // this app's own tokens
  return out;
}
const CU_PROTECTED_FILES = [/\.env$/i, /\.pem$/i, /\.key$/i, /id_rsa/i, /id_ed25519/i, /^\.netrc$/i, /^\.npmrc$/i, /^\.pypirc$/i, /^credentials$/i, /^kubeconfig$/i, /^secure\.json$/i, /^computer-use(-log)?\.json$/i];

function cuIsProtected(abs) {
  const low = abs.toLowerCase();
  for (const d of cuProtectedDirs()) {
    const dl = d.toLowerCase();
    if (low === dl || low.startsWith(dl + path.sep)) return true;
  }
  if (CU_PROTECTED_FILES.some((re) => re.test(path.basename(abs)))) return true;
  return false;
}

// Expand a leading ~ to the user's home folder (models often write ~/Documents)
function cuExpandUser(p) {
  if (typeof p !== 'string' || !p) return p;
  const home = app.getPath('home');
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

// Default folder when the model passes "." or nothing: first approved root, else home
function cuDefaultDir(cfg) {
  if (cfg.fullAccess) return app.getPath('home');
  return (cfg.roots && cfg.roots[0]) || app.getPath('home');
}

// Resolve a path the model asked for; it must land inside an approved root
// (unless the user switched on full computer access).
function cuResolve(p) {
  const cfg = cuConfig();
  if (typeof p !== 'string' || !p.trim()) {
    return { ok: false, error: 'Give an absolute file path (e.g. ' + path.join(app.getPath('home'), 'Documents', 'notes.txt') + ').' };
  }
  p = cuExpandUser(p.trim());
  const roots = (cfg.roots || []).map((r) => {
    try { return fs.realpathSync(r); } catch (e) { return path.resolve(r); }
  });
  let abs;
  try { abs = fs.realpathSync(path.resolve(p)); } catch (e) { abs = path.resolve(p); } // new files may not exist yet
  const root = roots.find((r) => abs === r || abs.startsWith(r + path.sep));
  if (!cfg.fullAccess && !root) {
    return {
      ok: false,
      error: 'That path is outside the folders approved for computer use.' +
        (roots.length ? ' Approved folders: ' + roots.join(' ; ') : ' No folders have been approved yet.') +
        ' Ask the user to approve the folder in Settings, or to switch on full computer access.'
    };
  }
  if (cuIsProtected(abs)) return { ok: false, error: 'That path holds credentials or app data and is never available to computer use.' };
  return { ok: true, abs, root: root || null };
}

/* Approval gate. Manual mode asks every time (with an "Approve for me"
 * shortcut that switches to auto mode). Auto mode approves on its own so the
 * AI can keep working; the audit log still records everything. */
async function cuApprove(title, detail) {
  const cfg = cuConfig();
  if (cfg.approvalMode === 'auto') {
    cuLog({ tool: 'mode', detail: 'Auto-approved (approve for me): ' + title, allowed: true });
    return true;
  }
  if (!win) return false;
  const choice = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Computer use — approval needed',
    message: title,
    detail,
    buttons: ['Allow', 'Approve for me — auto from now on', 'Deny'],
    defaultId: 2,
    cancelId: 2,
    noLink: true
  });
  if (choice.response === 1) {
    cfg.approvalMode = 'auto';
    cuWrite(cfg);
    cuLog({ tool: 'mode', detail: 'Approval mode switched to auto (approve for me)', allowed: true });
    return true;
  }
  return choice.response === 0;
}

const CU_BLOCKED_COMMANDS = [
  /\bsudo\b/, /\bdoas\b/,                    // never elevated
  /\brm\b[^|;&]*\s+\/(\s|$)/,                // rm targeting /
  /\brm\b[^|;&]*\s+~\/?(\s|$)/,              // rm targeting home
  /mkfs/, /\bdd\b[^|;&]*\bif=/,              // disk destruction
  /:\(\)\s*\{.*\}\s*;\s*:/,                  // fork bomb
  /\b(shutdown|reboot|halt)\b/,
  /\bkillall\b/, /\bkill\s+-9\s+-1\b/,
  /\bchmod\s+777\b/, /\bchown\b[^|;&]*-R/,
  /(\bcurl|\bwget|\bfetch)\b[^|;&]*\|\s*(ba)?z?sh\b/, // download-and-run
  /\bnc\b|\bncat\b|\bnetcat\b/,              // raw sockets
  /\bxattr\b[^|;&]*-d/,                      // stripping macOS quarantine flags
  /\bhistory\s+-c\b/, /\bshred\b/, /\bfsck\b/
];

function cuCommandBlocked(command) {
  const c = String(command || '');
  return CU_BLOCKED_COMMANDS.find((re) => re.test(c));
}

/* ---------- Installed desktop apps: ChatGPT (Cowork) & Claude 2.0 ----------
 * Detects whether the official ChatGPT and Claude desktop apps are installed
 * so the sign-in flow can auto-connect instead of asking the user to choose.
 * Nothing is read from those apps — only their presence on disk is checked.
 */
const { execFile } = require('child_process');

function dirExists(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }

function detectMacApps() {
  const found = { chatgpt: false, claude: false, cowork: false };
  const bases = ['/Applications', path.join(app.getPath('home'), 'Applications')];
  for (const base of bases) {
    let names;
    try { names = fs.readdirSync(base); } catch (e) { continue; }
    for (const n of names) {
      if (/^ChatGPT\.app$/i.test(n)) { found.chatgpt = true; found.cowork = true; }
      if (/^Claude( [\d.]+)?\.app$/i.test(n)) found.claude = true;
    }
  }
  return found;
}

function detectLinuxApps() {
  const found = { chatgpt: false, claude: false, cowork: false };
  const bases = [
    path.join(app.getPath('home'), '.local', 'share', 'applications'),
    '/usr/share/applications',
    '/var/lib/flatpak/exports/share/applications',
    path.join(app.getPath('home'), '.local', 'share', 'flatpak', 'exports', 'share', 'applications')
  ];
  for (const base of bases) {
    let files;
    try { files = fs.readdirSync(base); } catch (e) { continue; }
    for (const f of files) {
      if (/^(chatgpt|com\.openai\.chat)/i.test(f)) { found.chatgpt = true; found.cowork = true; }
      if (/^(claude|com\.anthropic\.claude)/i.test(f)) found.claude = true;
    }
  }
  return found;
}

function detectWinApps() {
  const found = { chatgpt: false, claude: false, cowork: false };
  const local = process.env.LOCALAPPDATA || '';
  const pfs = [process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'];
  const chatgptDirs = [path.join(local, 'Programs', 'ChatGPT'), path.join(pfs[0], 'ChatGPT'), path.join(pfs[1], 'ChatGPT')];
  const claudeDirs = [path.join(local, 'AnthropicClaude'), path.join(local, 'Programs', 'Claude'), path.join(pfs[0], 'Claude')];
  for (const d of chatgptDirs) if (dirExists(d)) { found.chatgpt = true; found.cowork = true; break; }
  for (const d of claudeDirs) if (dirExists(d)) { found.claude = true; break; }
  return found;
}

function winRegistryHas(displayName) {
  // Best-effort check of the uninstall list for the app's display name
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const roots = ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'];
    let left = roots.length;
    roots.forEach((root) => {
      execFile('reg', ['query', root, '/s', '/f', displayName, '/d'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
        if (stdout && new RegExp(displayName, 'i').test(stdout)) finish(true);
        if (--left === 0) finish(false);
      });
    });
    setTimeout(() => finish(false), 10000);
  });
}

async function detectInstalledApps() {
  let found = { chatgpt: false, claude: false, cowork: false };
  try {
    if (process.platform === 'darwin') found = detectMacApps();
    else if (process.platform === 'win32') found = detectWinApps();
    else found = detectLinuxApps();
    if (process.platform === 'win32') {
      // The ChatGPT Windows app can install through the Store, which leaves no
      // folder — fall back to the registry's uninstall list.
      if (!found.chatgpt && await winRegistryHas('ChatGPT')) { found.chatgpt = true; found.cowork = true; }
      if (!found.claude && await winRegistryHas('Claude')) found.claude = true;
    }
  } catch (e) { /* detection is best-effort */ }
  found.platform = process.platform;
  return found;
}

ipcMain.handle('apps:detect', () => detectInstalledApps());

ipcMain.handle('apps:launch', (event, name) => {
  const target = String(name || '').toLowerCase() === 'claude' ? 'claude' : 'chatgpt';
  return new Promise((resolve) => {
    try {
      if (process.platform === 'darwin') {
        const appName = target === 'claude' ? 'Claude' : 'ChatGPT';
        execFile('open', ['-a', appName], (err) => resolve({ ok: !err }));
      } else if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA || '';
        const candidates = target === 'claude'
          ? [path.join(local, 'AnthropicClaude', 'claude.exe'), path.join(local, 'Programs', 'Claude', 'Claude.exe')]
          : [path.join(local, 'Programs', 'ChatGPT', 'ChatGPT.exe')];
        const exe = candidates.find((c) => dirExists(c));
        if (!exe) return resolve({ ok: false, error: 'Could not find the app.' });
        const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        resolve({ ok: true });
      } else if (process.platform === 'linux') {
        execFile('gtk-launch', [target === 'claude' ? 'claude' : 'chatgpt'], (err) => resolve({ ok: !err }));
      } else {
        resolve({ ok: false, error: 'Not supported on this system.' });
      }
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
});

ipcMain.handle('computer:status', () => {
  const cfg = cuConfig();
  return {
    supported: true, enabled: !!cfg.enabled, roots: cfg.roots || [], platform: process.platform,
    approvalMode: cfg.approvalMode === 'auto' ? 'auto' : 'manual',
    fullAccess: !!cfg.fullAccess,
    browserOpen: browserTabs().length > 0
  };
});

ipcMain.handle('computer:set-enabled', (event, on) => {
  const cfg = cuConfig();
  cfg.enabled = !!on;
  cuWrite(cfg);
  cuLog({ tool: 'mode', detail: on ? 'Computer use turned on' : 'Computer use turned off', allowed: true });
  return { enabled: !!on };
});

ipcMain.handle('computer:set-approval-mode', (event, mode) => {
  const cfg = cuConfig();
  cfg.approvalMode = mode === 'auto' ? 'auto' : 'manual';
  cuWrite(cfg);
  cuLog({ tool: 'mode', detail: 'Approval mode: ' + cfg.approvalMode, allowed: true });
  return { approvalMode: cfg.approvalMode };
});

ipcMain.handle('computer:set-full-access', async (event, on) => {
  const cfg = cuConfig();
  if (on) {
    // Turning on full computer access is itself a permissioned action
    const sure = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Full computer access',
      message: 'Give the AI full access to this computer?',
      detail: 'The AI will be able to read and change files anywhere on this computer, and open and use apps — not just inside the folders you approved earlier.\n\nCredentials, SSH keys, keychains, .env files and this app\'s own data are always blocked, whatever you choose. Writes, commands and app launches still follow your approval setting (manual or approve-for-me).',
      buttons: ['Enable full access', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    });
    if (sure.response !== 0) return { fullAccess: !!cfg.fullAccess };
  }
  cfg.fullAccess = !!on;
  cuWrite(cfg);
  cuLog({ tool: 'mode', detail: on ? 'Full computer access ENABLED' : 'Full computer access turned off (approved folders only)', allowed: true });
  return { fullAccess: !!cfg.fullAccess };
});

ipcMain.handle('computer:add-root', async () => {
  const cfg = cuConfig();
  const res = await dialog.showOpenDialog(win, { title: 'Approve a folder for computer use', properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, error: 'No folder chosen' };
  const root = res.filePaths[0];
  if (cuIsProtected(root)) return { ok: false, error: 'That folder holds credentials or app data and cannot be approved.' };
  cfg.roots = cfg.roots || [];
  if (!cfg.roots.includes(root)) cfg.roots.push(root);
  cuWrite(cfg);
  cuLog({ tool: 'mode', detail: 'Folder approved: ' + root, allowed: true });
  return { ok: true, roots: cfg.roots };
});

ipcMain.handle('computer:remove-root', (event, root) => {
  const cfg = cuConfig();
  cfg.roots = (cfg.roots || []).filter((r) => r !== root);
  cuWrite(cfg);
  cuLog({ tool: 'mode', detail: 'Folder removed: ' + root, allowed: true });
  return { ok: true, roots: cfg.roots };
});

ipcMain.handle('computer:log', () => {
  try { return JSON.parse(fs.readFileSync(CU_LOG(), 'utf8')).slice(-50); } catch (e) { return []; }
});

/* ---------- AI Browser: an embedded Chromium the assistant can drive ----------
 *
 * Every tab is its own BrowserWindow running the app's bundled Chromium.
 * Each tab gets a transparent, click-through overlay window that follows it
 * around and draws the AI's OWN mouse cursor — a purple-arrow pointer with an
 * "AI" badge. The user's real mouse is never moved or captured: the AI's
 * clicks are injected into the page's webContents, and the cursor the user
 * sees is just the overlay drawing. Pages the AI opens in new tabs are also
 * its own; the user's browser is never touched.
 */

const BROWSER_SEQ = { n: 0 };
let browserTabsAll = [];        // { id, win, overlay, url, title }
let browserActiveId = null;

function browserTabs() { return browserTabsAll; }
function browserActiveTab() {
  return browserTabsAll.find((t) => t.id === browserActiveId) || browserTabsAll[0] || null;
}

function browserNormalizeUrl(u) {
  u = String(u || '').trim();
  if (!u) return 'https://duckduckgo.com';
  if (/^https?:\/\//i.test(u)) return u;
  if (/^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(u) && !/\s/.test(u)) return 'https://' + u;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(u);
}

function browserOverlayHtml() {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;cursor:none}' +
    '#cursor{position:fixed;left:120px;top:120px;z-index:9999;filter:drop-shadow(0 1px 3px rgba(0,0,0,.35));transition:left .1s cubic-bezier(.2,.7,.3,1),top .1s cubic-bezier(.2,.7,.3,1)}' +
    '#cursor svg{display:block}' +
    '#badge{position:fixed;left:140px;top:134px;font:700 9px system-ui,sans-serif;color:#fff;background:#7c5cff;border-radius:6px;padding:1px 4px;z-index:10000;transition:left .1s cubic-bezier(.2,.7,.3,1),top .1s cubic-bezier(.2,.7,.3,1)}' +
    '#ring{position:fixed;left:0;top:0;width:30px;height:30px;border:2.5px solid #7c5cff;border-radius:50%;opacity:0;transform:translate(-50%,-50%);z-index:9998}' +
    '@keyframes aiRing{0%{opacity:.95;transform:translate(-50%,-50%) scale(.35)}100%{opacity:0;transform:translate(-50%,-50%) scale(1.9)}}' +
    '#ring.go{animation:aiRing .55s ease-out}' +
    '</style></head><body>' +
    '<div id="cursor"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4.5 2.5l13 7.9-5.6 1.1-2.6 6-4.8-15z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg></div>' +
    '<span id="badge">AI</span><div id="ring"></div>' +
    '<script>function aiMove(x,y){var c=document.getElementById("cursor");c.style.left=x+"px";c.style.top=y+"px";var b=document.getElementById("badge");b.style.left=(x+18)+"px";b.style.top=(y+13)+"px";}' +
    'function aiClick(x,y){var r=document.getElementById("ring");r.style.left=x+"px";r.style.top=y+"px";r.classList.remove("go");void r.offsetWidth;r.classList.add("go");}' +
    'function aiShow(){document.getElementById("cursor").style.display="block";document.getElementById("badge").style.display="block";}' +
    'function aiHide(){document.getElementById("cursor").style.display="none";document.getElementById("badge").style.display="none";}' +
    'aiHide();<\/script></body></html>'
  );
}

function browserSyncOverlay(tab) {
  if (!tab.win || tab.overlay.isDestroyed()) return;
  try {
    const b = tab.win.getBounds();
    tab.overlay.setBounds(b);
    tab.overlay.setVisible(tab.win.isVisible() && tab.win.isFocused());
  } catch (e) { /* window may be mid-teardown */ }
}

function browserCreateTab(rawUrl) {
  const url = browserNormalizeUrl(rawUrl);
  const id = 'tab' + (++BROWSER_SEQ.n);
  const content = new BrowserWindow({
    width: 1100, height: 720, minWidth: 400, minHeight: 300,
    title: 'AI Browser — ' + id, backgroundColor: '#ffffff', show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
  });
  content.loadURL(url);

  const overlay = new BrowserWindow({
    transparent: true, frame: false, alwaysOnTop: true, focusable: false,
    skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  overlay.setIgnoreMouseEvents(true, { forward: false });
  overlay.loadURL(browserOverlayHtml());

  const tab = { id, win: content, overlay, url, title: url };
  browserTabsAll.push(tab);
  browserActiveId = id;

  // Keep the cursor overlay glued to the page window
  const sync = () => browserSyncOverlay(tab);
  content.on('move', sync);
  content.on('resize', sync);
  content.on('maximize', sync);
  content.on('unmaximize', sync);
  content.on('restore', sync);
  content.on('show', sync);
  content.on('focus', sync);
  content.on('blur', () => { try { tab.overlay.setVisible(false); } catch (e) {} });
  content.on('page-title-updated', (e, title) => { tab.title = title; });
  content.webContents.on('did-navigate', (e, u) => { tab.url = u; });
  content.webContents.on('did-navigate-in-page', (e, u) => { tab.url = u; });

  // Links that open new windows become new AI Browser tabs
  content.webContents.setWindowOpenHandler(({ url: u }) => {
    browserCreateTab(u);
    return { action: 'deny' };
  });

  content.once('ready-to-show', () => {
    content.show();
    sync();
  });
  content.on('closed', () => {
    try { if (!overlay.isDestroyed()) overlay.destroy(); } catch (e) {}
    browserTabsAll = browserTabsAll.filter((t) => t.id !== id);
    if (browserActiveId === id) browserActiveId = browserTabsAll.length ? browserTabsAll[browserTabsAll.length - 1].id : null;
  });
  cuLog({ tool: 'browser', detail: 'AI Browser tab opened: ' + url, allowed: true });
  return tab;
}

async function browserEnsure() {
  let tab = browserActiveTab();
  if (!tab || tab.win.isDestroyed()) {
    tab = browserCreateTab('https://duckduckgo.com');
    // give the page a moment to start loading so follow-up reads work
    await new Promise((r) => setTimeout(r, 400));
  }
  return tab;
}

/* Wait for the page to finish loading (or fail / time out) so the model is not
 * told a page is ready while it is still blank. */
function browserWaitLoad(tab, ms) {
  return new Promise((resolve) => {
    if (!tab || !tab.win || tab.win.isDestroyed()) return resolve();
    const wc = tab.win.webContents;
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    if (!wc.isLoadingMainFrame()) return finish();
    wc.once('did-finish-load', finish);
    wc.once('did-fail-load', finish);
    setTimeout(finish, ms || 12000);
  });
}

function browserCursor(tab, x, y) {
  if (!tab || tab.overlay.isDestroyed()) return;
  tab.overlay.webContents.executeJavaScript('aiShow();aiMove(' + Math.round(x) + ',' + Math.round(y) + ');', true).catch(() => {});
}

async function browserClick(tab, x, y) {
  if (!tab || tab.win.isDestroyed()) return;
  tab.win.focus();
  browserCursor(tab, x, y);
  const wc = tab.win.webContents;
  wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
  wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  if (!tab.overlay.isDestroyed()) tab.overlay.webContents.executeJavaScript('aiClick(' + Math.round(x) + ',' + Math.round(y) + ');', true).catch(() => {});
  // small settle time so the page can react before the next tool call
  await new Promise((r) => setTimeout(r, 250));
}

ipcMain.handle('computer:call', async (event, tool, args) => {
  const cfg = cuConfig();
  if (!cfg.enabled) return { ok: false, error: 'Computer use is turned off.' };
  args = args || {};
  // accept both "computer_list_files" and "list_files"
  tool = String(tool || '').replace(/^computer_/, '');

  if (tool === 'list_files') {
    const r = cuResolve(args.path || cuDefaultDir(cfg));
    if (!r.ok) return r;
    let names;
    try { names = fs.readdirSync(r.abs, { withFileTypes: true }); }
    catch (e) { return { ok: false, error: 'Could not read that folder: ' + e.message }; }
    const rows = names.slice(0, 500).map((d) => {
      let size = '';
      try { if (d.isFile()) size = ' ' + fs.statSync(path.join(r.abs, d.name)).size + 'B'; } catch (e) { /* ignore */ }
      return (d.isDirectory() ? 'dir  ' : 'file ') + d.name + size;
    });
    cuLog({ tool, detail: args.path, allowed: true });
    return { ok: true, result: (rows.length ? rows.join('\n') : '(empty folder)') + (names.length > 500 ? '\n… truncated at 500 entries' : '') };
  }

  if (tool === 'read_file') {
    const r = cuResolve(args.path);
    if (!r.ok) return r;
    let st;
    try { st = fs.statSync(r.abs); }
    catch (e) { return { ok: false, error: 'File not found: ' + e.message }; }
    if (st.size > 256 * 1024) return { ok: false, error: 'File is larger than 256 KB; ask the user to point at a smaller file.' };
    let text;
    try { text = fs.readFileSync(r.abs, 'utf8'); }
    catch (e) { return { ok: false, error: 'Could not read that file: ' + e.message }; }
    cuLog({ tool, detail: args.path, allowed: true });
    return { ok: true, result: text };
  }

  if (tool === 'write_file') {
    const r = cuResolve(args.path);
    if (!r.ok) return r;
    const content = typeof args.content === 'string' ? args.content : '';
    if (content.length > 1024 * 1024) return { ok: false, error: 'Write is larger than 1 MB.' };
    const allowed = await cuApprove(
      'Write file',
      'The assistant wants to write ' + content.length + ' characters to:\n' + r.abs +
      '\n\nYou can review the full content in the chat before allowing. Nothing is written unless you click Allow.'
    );
    if (!allowed) { cuLog({ tool, detail: args.path + ' (denied)', allowed: false }); return { ok: false, error: 'The user did not allow this write.' }; }
    try { fs.mkdirSync(path.dirname(r.abs), { recursive: true }); fs.writeFileSync(r.abs, content, { mode: 0o644 }); }
    catch (e) { return { ok: false, error: 'Write failed: ' + e.message }; }
    cuLog({ tool, detail: args.path + ' (' + content.length + ' chars)', allowed: true });
    return { ok: true, result: 'Written to ' + r.abs };
  }

  if (tool === 'run_command') {
    const command = String(args.command || '');
    if (!command.trim()) return { ok: false, error: 'Empty command.' };
    const blocked = cuCommandBlocked(command);
    if (blocked) {
      cuLog({ tool, detail: command.slice(0, 200) + ' (blocked)', allowed: false });
      return { ok: false, error: 'That command is blocked by the computer-use safety rules (it looks elevated, destructive or self-hiding).' };
    }
    const cwdR = cuResolve(args.cwd || cuDefaultDir(cfg));
    if (!cwdR.ok) return cwdR;
    const allowed = await cuApprove(
      'Run command',
      'The assistant wants to run:\n' + command + '\n\nin:\n' + cwdR.abs +
      '\n\nIt will be killed after 60 seconds and can never run elevated (sudo is blocked).'
    );
    if (!allowed) { cuLog({ tool, detail: command.slice(0, 200) + ' (denied)', allowed: false }); return { ok: false, error: 'The user did not allow this command.' }; }

    const result = await new Promise((resolve) => {
      const shellFile = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
      const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
      const child = spawn(shellFile, shellArgs, { cwd: cwdR.abs, windowsHide: true, env: process.env });
      let out = '', killed = false;
      const cap = 64 * 1024;
      child.stdout.on('data', (d) => { if (out.length < cap) out += d.toString('utf8', 0, cap - out.length); });
      child.stderr.on('data', (d) => { if (out.length < cap) out += d.toString('utf8', 0, cap - out.length); });
      const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } }, 60 * 1000);
      child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: 'Could not start the command: ' + e.message }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ ok: true, result: 'exit code ' + code + (killed ? ' (killed: took longer than 60 seconds)' : '') + '\n' + (out || '(no output)') });
      });
    });
    cuLog({ tool, detail: command.slice(0, 200) + ' @ ' + cwdR.abs, allowed: true });
    return result;
  }

  /* ---------- AI Browser (embedded Chromium) ---------- */

  if (tool === 'browser_open' || tool === 'browser_navigate') {
    const tab = await browserEnsure();
    const url = browserNormalizeUrl(args.url);
    if (tab.url !== url) tab.win.loadURL(url);
    tab.win.show();
    // wait for the page to finish loading so the next read/click works
    await browserWaitLoad(tab, 15000);
    cuLog({ tool, detail: url, allowed: true });
    return { ok: true, result: 'Opened ' + url + ' in the AI Browser (tab ' + tab.id + ') and it has finished loading. Use browser_read_page to read it (it also lists clickable elements with their x,y coordinates for browser_click), or browser_click / browser_click_selector to act on it with your own mouse cursor.' };
  }

  if (tool === 'browser_new_tab') {
    const tab = browserCreateTab(args.url);
    return { ok: true, result: 'New AI Browser tab ' + tab.id + ' opened at ' + tab.url + '. It is now the active tab.' };
  }

  if (tool === 'browser_close_tab') {
    const id = String(args.id || '');
    const tab = browserTabsAll.find((t) => t.id === id);
    if (!tab) return { ok: false, error: 'No tab with id ' + id + '. Use browser_tabs to list them.' };
    tab.win.close();
    return { ok: true, result: 'Tab ' + id + ' closed.' };
  }

  if (tool === 'browser_tabs') {
    if (!browserTabsAll.length) return { ok: true, result: 'No AI Browser tabs are open. Use browser_open to start one.' };
    return {
      ok: true,
      result: 'AI Browser tabs (the one marked active is where clicks and typing go):\n' +
        browserTabsAll.map((t) => '- ' + t.id + (t.id === browserActiveId ? ' (active)' : '') + ' ' + (t.title || '').slice(0, 80) + ' — ' + t.url).join('\n')
    };
  }

  if (tool === 'browser_read_page') {
    const tab = await browserEnsure();
    // if the page is still loading, give it a moment so we do not read a blank page
    await browserWaitLoad(tab, 10000);
    let info;
    try {
      const raw = await tab.win.webContents.executeJavaScript(
        '(function(){var t=document.body?document.body.innerText:"";' +
        'var els=Array.prototype.slice.call(document.querySelectorAll("a,button,input,select,textarea,[role=button],[onclick]"),0,80).map(function(e){' +
        'try{var r=e.getBoundingClientRect();if(r.width<2||r.height<2)return null;' +
        'var txt=(e.innerText||e.value||e.placeholder||e.getAttribute("aria-label")||"").trim().slice(0,50);' +
        'return e.tagName.toLowerCase()+" \""+txt+"\" @ "+Math.round(r.x+r.width/2)+","+Math.round(r.y+r.height/2);}catch(err){return null;}}).filter(Boolean);' +
        'return JSON.stringify({title:document.title,url:location.href,text:t.slice(0,12000),textLen:t.length,' +
        'els:els,' +
        'links:Array.prototype.slice.call(document.querySelectorAll("a"),0,40).map(function(a){return (a.innerText||"").trim().slice(0,60)+" -> "+a.href;})});})()',
        true
      );
      info = JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: 'Could not read the page (it may still be loading): ' + e.message };
    }
    cuLog({ tool, detail: info.url, allowed: true });
    return {
      ok: true,
      result: 'Page: ' + info.title + '\nURL: ' + info.url + '\n\nText (' + info.textLen + ' chars' + (info.textLen > 12000 ? ', first 12000 shown' : '') + '):\n' + (info.text || '(no text)') +
        (info.els && info.els.length ? '\n\nClickable elements (tag "text" @ x,y — pass those coordinates to browser_click):\n' + info.els.map((l) => '- ' + l).join('\n') : '') +
        (info.links && info.links.length ? '\n\nLinks:\n' + info.links.map((l) => '- ' + l).join('\n') : '')
    };
  }

  if (tool === 'browser_screenshot') {
    const tab = await browserEnsure();
    await browserWaitLoad(tab, 10000);
    try {
      const img = await tab.win.webContents.capturePage();
      const dir = path.join(app.getPath('userData'), 'screenshots');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'ai-browser-' + Date.now() + '.png');
      fs.writeFileSync(file, img.toPNG());
      cuLog({ tool, detail: file, allowed: true });
      return { ok: true, result: 'Screenshot saved to ' + file + '. The user can open this file to see exactly what the AI Browser shows. Coordinates in the screenshot match the browser_click x/y coordinates.' };
    } catch (e) {
      return { ok: false, error: 'Screenshot failed: ' + e.message };
    }
  }

  if (tool === 'browser_click' || tool === 'ai_mouse_click') {
    const tab = await browserEnsure();
    const x = Number(args.x), y = Number(args.y);
    if (!isFinite(x) || !isFinite(y)) return { ok: false, error: 'Give numeric x and y coordinates (pixels from the top-left of the AI Browser window). Use browser_read_page — it lists clickable elements with their x,y coordinates.' };
    await browserWaitLoad(tab, 10000);
    // clamp to the visible page so an out-of-range coordinate still clicks the nearest edge
    const size = tab.win.getContentSize();
    const cx = Math.max(0, Math.min(Math.round(x), (size[0] || 1280) - 1));
    const cy = Math.max(0, Math.min(Math.round(y), (size[1] || 720) - 1));
    // what is under the point? tell the model what it actually clicked
    let hit = '';
    try {
      hit = await tab.win.webContents.executeJavaScript(
        '(function(){var e=document.elementFromPoint(' + cx + ',' + cy + ');if(!e)return "";' +
        'var t=(e.innerText||e.value||e.getAttribute("aria-label")||"").trim().slice(0,60);' +
        'return e.tagName.toLowerCase()+(t?" \\""+t+"\\"":"");})()',
        true
      );
    } catch (e) { /* best-effort */ }
    await browserClick(tab, cx, cy);
    cuLog({ tool, detail: 'click @ ' + cx + ',' + cy + ' (' + tab.url + ')', allowed: true });
    return { ok: true, result: 'Clicked at ' + cx + ',' + cy + ' in the AI Browser with the AI cursor' + (hit ? ' — it hit a ' + hit : '') + '. Use browser_read_page to see what changed.' };
  }

  if (tool === 'ai_mouse_move') {
    const tab = await browserEnsure();
    const x = Number(args.x), y = Number(args.y);
    if (!isFinite(x) || !isFinite(y)) return { ok: false, error: 'Give numeric x and y coordinates.' };
    browserCursor(tab, x, y);
    tab.win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
    return { ok: true, result: 'AI cursor moved to ' + Math.round(x) + ',' + Math.round(y) + '.' };
  }

  if (tool === 'browser_click_selector') {
    const tab = await browserEnsure();
    const sel = String(args.selector || '');
    if (!sel) return { ok: false, error: 'Give a CSS selector to click, e.g. "button[type=submit]" or "a[href*=login]".' };
    let pos;
    try {
      const raw = await tab.win.webContents.executeJavaScript(
        '(function(){var el=document.querySelector(' + JSON.stringify(sel) + ');if(!el)return null;el.scrollIntoView({block:"center"});var b=el.getBoundingClientRect();return JSON.stringify({x:b.x+b.width/2,y:b.y+b.height/2});})()',
        true
      );
      pos = raw ? JSON.parse(raw) : null;
    } catch (e) {
      return { ok: false, error: 'Selector failed: ' + e.message };
    }
    if (!pos) return { ok: false, error: 'No element matches "' + sel + '" on this page.' };
    await browserClick(tab, pos.x, pos.y);
    cuLog({ tool, detail: sel + ' @ ' + Math.round(pos.x) + ',' + Math.round(pos.y), allowed: true });
    return { ok: true, result: 'Clicked "' + sel + '" at ' + Math.round(pos.x) + ',' + Math.round(pos.y) + ' with the AI cursor.' };
  }

  if (tool === 'browser_type' || tool === 'ai_type') {
    const tab = await browserEnsure();
    const text = String(args.text == null ? '' : args.text);
    if (!text) return { ok: false, error: 'Nothing to type — give the text.' };
    await browserWaitLoad(tab, 10000);
    tab.win.focus();
    // if nothing is focused, focus the first editable field so the text lands somewhere
    try {
      await tab.win.webContents.executeJavaScript(
        '(function(){var a=document.activeElement;' +
        'if(a&&(a.tagName==="INPUT"||a.tagName==="TEXTAREA"||a.isContentEditable))return "ok";' +
        'var e=document.querySelector("input:not([type=hidden]):not([disabled]),textarea:not([disabled]),[contenteditable=true]");' +
        'if(e){e.focus();return "focused"}return "none";})()',
        true
      );
    } catch (e) { /* best-effort */ }
    tab.win.webContents.insertText(text);
    cuLog({ tool, detail: 'typed ' + text.length + ' chars (' + tab.url + ')', allowed: true });
    return { ok: true, result: 'Typed ' + text.length + ' characters into the AI Browser (first editable field if none was focused). Use browser_read_page to see what changed.' };
  }

  if (tool === 'browser_key' || tool === 'ai_key') {
    const tab = await browserEnsure();
    // accept the aliases models actually send ("enter", "return", "esc", "ctrl+a", …)
    var KEY_ALIASES = { enter: 'Enter', return: 'Enter', '\n': 'Enter', esc: 'Escape', escape: 'Escape', del: 'Delete', 'delete': 'Delete', backspace: 'Backspace', space: 'Space', tab: 'Tab', left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' };
    var rawKey = String(args.key == null ? 'Enter' : args.key).trim();
    var parts = rawKey.toLowerCase().split('+').map(function (s) { return s.trim(); }).filter(Boolean);
    var modifiers = parts.slice(0, -1).map(function (m) {
      return { ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', shift: 'Shift', meta: 'Meta', cmd: 'Meta', super: 'Meta', win: 'Meta' }[m] || null;
    }).filter(Boolean);
    var keyName = parts[parts.length - 1] || 'Enter';
    keyName = KEY_ALIASES[keyName] || keyName.charAt(0).toUpperCase() + keyName.slice(1);
    tab.win.focus();
    const wc = tab.win.webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: keyName, modifiers: modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode: keyName, modifiers: modifiers });
    return { ok: true, result: 'Sent key "' + rawKey + '" to the AI Browser.' };
  }

  if (tool === 'browser_scroll') {
    const tab = await browserEnsure();
    const amount = Math.min(10, Math.max(1, Number(args.amount) || 3));
    const dir = String(args.direction || 'down') === 'up' ? -1 : 1;
    const size = tab.win.getContentSize();
    const x = Math.round((size[0] || 800) / 2), y = Math.round((size[1] || 600) / 2);
    tab.win.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: dir * amount * 120 });
    browserCursor(tab, x, y);
    return { ok: true, result: 'Scrolled ' + (dir === 1 ? 'down' : 'up') + ' by ' + amount + ' notches in the AI Browser.' };
  }

  if (tool === 'browser_back' || tool === 'browser_forward') {
    const tab = await browserEnsure();
    try { tab.win.webContents.navigationHistory[tool === 'browser_back' ? 'goBack' : 'goForward'](); }
    catch (e) { return { ok: false, error: 'Navigation failed: ' + e.message }; }
    return { ok: true, result: (tool === 'browser_back' ? 'Went back' : 'Went forward') + ' in the AI Browser.' };
  }

  /* ---------- Open apps / anything ----------
   * (the computer_ prefix was already stripped above, so these check the bare
   * names — the old code checked "computer_open_app" and could never match,
   * which silently broke all three app tools) ---------- */

  if (tool === 'open_app' || tool === 'computer_open_app') {
    const name = String(args.name || '').trim();
    if (!name) return { ok: false, error: 'Give the app name, e.g. "Safari", "Calculator", "VS Code".' };
    const allowed = await cuApprove(
      'Open an app',
      'The assistant wants to open the app "' + name + '" on this computer.'
    );
    if (!allowed) { cuLog({ tool, detail: 'open app ' + name + ' (denied)', allowed: false }); return { ok: false, error: 'The user did not allow opening that app.' }; }
    const launched = await new Promise((resolve) => {
      try {
        if (process.platform === 'darwin') {
          execFile('open', ['-a', name], (err) => resolve({ ok: !err, error: err ? 'No app named "' + name + '" was found. Use computer_list_apps to see what is installed.' : null }));
        } else if (process.platform === 'win32') {
          execFile('cmd', ['/d', '/s', '/c', 'start', '', name], { windowsHide: true }, (err) => resolve({ ok: !err, error: err ? 'Could not start "' + name + '". Use computer_list_apps to see what is installed.' : null }));
        } else {
          execFile('gtk-launch', [String(name).toLowerCase().replace(/\s+/g, '-')], (err) => {
            if (!err) return resolve({ ok: true });
            execFile('sh', ['-c', 'command -v ' + JSON.stringify(name)], (e2, out) => {
              if (out && out.trim()) return resolve({ ok: true, via: out.trim() });
              resolve({ ok: false, error: 'Could not find "' + name + '". Use computer_list_apps to see what is installed.' });
            });
          });
        }
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
    cuLog({ tool, detail: 'open app ' + name + (launched.ok ? '' : ' (failed)'), allowed: true });
    if (!launched.ok) return { ok: false, error: launched.error };
    return { ok: true, result: 'App "' + name + '" is opening.' };
  }

  if (tool === 'list_apps' || tool === 'computer_list_apps') {
    const names = new Set();
    try {
      const home = app.getPath('home');
      if (process.platform === 'darwin') {
        ['/Applications', path.join(home, 'Applications')].forEach((base) => {
          let list; try { list = fs.readdirSync(base); } catch (e) { return; }
          list.forEach((n) => { if (/\.app$/i.test(n)) names.add(n.replace(/\.app$/i, '')); });
        });
      } else if (process.platform === 'win32') {
        const roots = [process.env.APPDATA, process.env.ProgramData, process.env['ProgramFiles(x86)']].filter(Boolean);
        roots.forEach((base) => {
          const dir = path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
          let stack = [dir];
          while (stack.length) {
            const d = stack.pop();
            let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
            list.forEach((f) => {
              if (f.isDirectory()) stack.push(path.join(d, f.name));
              else if (/\.lnk$/i.test(f.name)) names.add(f.name.replace(/\.lnk$/i, ''));
            });
          }
        });
      } else {
        const bases = [
          path.join(home, '.local', 'share', 'applications'),
          '/usr/share/applications',
          '/usr/local/share/applications',
          '/var/lib/flatpak/exports/share/applications'
        ];
        bases.forEach((base) => {
          let list; try { list = fs.readdirSync(base); } catch (e) { return; }
          list.forEach((f) => { if (/\.desktop$/i.test(f)) names.add(f.replace(/\.desktop$/i, '')); });
        });
      }
    } catch (e) { /* best-effort */ }
    const sorted = Array.from(names).sort();
    if (!sorted.length) return { ok: false, error: 'Could not list apps on this system.' };
    cuLog({ tool, detail: 'listed ' + sorted.length + ' apps', allowed: true });
    return { ok: true, result: 'Installed apps (use the exact name with computer_open_app):\n' + sorted.slice(0, 400).join('\n') + (sorted.length > 400 ? '\n… truncated at 400 of ' + sorted.length : '') };
  }

  if (tool === 'open_url' || tool === 'computer_open_url') {
    const url = browserNormalizeUrl(args.url);
    const where = args.where === 'default' ? 'default' : 'browser';
    if (where === 'default') {
      const allowed = await cuApprove(
        'Open a link in your browser',
        'The assistant wants to open this link in your default browser (outside the AI Browser):\n' + url
      );
      if (!allowed) { cuLog({ tool, detail: url + ' (denied)', allowed: false }); return { ok: false, error: 'The user did not allow opening that link in their browser.' }; }
      await shell.openExternal(url);
      cuLog({ tool, detail: url + ' (default browser)', allowed: true });
      return { ok: true, result: 'Opened ' + url + ' in the user\'s default browser.' };
    }
    const tab = await browserEnsure();
    tab.win.loadURL(url);
    await browserWaitLoad(tab, 15000);
    cuLog({ tool, detail: url + ' (AI Browser)', allowed: true });
    return { ok: true, result: 'Opened ' + url + ' in the AI Browser and it has finished loading. Use browser_read_page to see its content.' };
  }

  return { ok: false, error: 'Unknown tool: ' + tool };
});

} // end single-instance branch
