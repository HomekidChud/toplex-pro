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
 *      (chosen with a native folder picker). Nothing outside is readable.
 *   2. Credentials and secrets are always off-limits: SSH/GPG/AWS keys,
 *      keychains, .env files, tokens and this app's own data folder.
 *   3. Every file write and every command is shown to the user in a native
 *      approval dialog and only runs if they click Allow. There is no
 *      "always allow" switch.
 *   4. Commands never run elevated (sudo/doas blocked), destructive and
 *      self-hiding patterns are blocked outright, and every command is
 *      killed after 60 seconds with its output capped.
 *   5. Everything the AI does is written to an audit log on this device.
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

// Resolve a path the model asked for; it must land inside an approved root.
function cuResolve(p) {
  const cfg = cuConfig();
  const roots = (cfg.roots || []).map((r) => {
    try { return fs.realpathSync(r); } catch (e) { return path.resolve(r); }
  });
  let abs;
  try { abs = fs.realpathSync(path.resolve(p)); } catch (e) { abs = path.resolve(p); } // new files may not exist yet
  const root = roots.find((r) => abs === r || abs.startsWith(r + path.sep));
  if (!root) return { ok: false, error: 'That path is outside the folders approved for computer use.' };
  if (cuIsProtected(abs)) return { ok: false, error: 'That path holds credentials or app data and is never available to computer use.' };
  return { ok: true, abs, root };
}

async function cuApprove(title, detail) {
  if (!win) return false;
  const choice = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Computer use — approval needed',
    message: title,
    detail,
    buttons: ['Allow', 'Deny'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  });
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
  return { supported: true, enabled: !!cfg.enabled, roots: cfg.roots || [], platform: process.platform };
});

ipcMain.handle('computer:set-enabled', (event, on) => {
  const cfg = cuConfig();
  cfg.enabled = !!on;
  cuWrite(cfg);
  cuLog({ tool: 'mode', detail: on ? 'Computer use turned on' : 'Computer use turned off', allowed: true });
  return { enabled: !!on };
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

ipcMain.handle('computer:call', async (event, tool, args) => {
  const cfg = cuConfig();
  if (!cfg.enabled) return { ok: false, error: 'Computer use is turned off.' };
  args = args || {};
  // accept both "computer_list_files" and "list_files"
  tool = String(tool || '').replace(/^computer_/, '');

  if (tool === 'list_files') {
    const r = cuResolve(args.path || '.');
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
    const cwdR = cuResolve(args.cwd || '.');
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

  return { ok: false, error: 'Unknown tool: ' + tool };
});

} // end single-instance branch
