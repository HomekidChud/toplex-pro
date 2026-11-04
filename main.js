/* Toplix Pro — Electron main process */
const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
