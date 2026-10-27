const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { stageBinaries, verifyBinary } = require('./binaries');
const ipc = require('./ipc');

let mainWindow = null;
let ipcHandle = null;

// Copy bundled binaries into a writable per-user dir and resolve their paths
// BEFORE anything spawns them. In dev the resources dir is the repo's (usually
// empty → PATH fallback); when packaged it's inside the app bundle.
function prepareBinaries() {
  const resourcesDir = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', '..', 'resources');
  const resolved = stageBinaries({ resourcesDir, userDataDir: app.getPath('userData') });
  for (const p of Object.values(resolved)) {
    if (!p) continue;
    verifyBinary(p).then((r) => { if (!r.ok) console.error(`Binary failed to run: ${p}\n${r.error}`); });
  }
}

// Packaged apps swallow console output, so a startup crash would be invisible.
// Record it and surface it rather than failing silently.
function reportStartupError(err) {
  const message = (err && err.stack) || String(err);
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'startup-error.log'), message);
  } catch { /* best effort */ }
  console.error('Startup error:', message);
  try {
    dialog.showErrorBox('Universal Downloader failed to start', message);
  } catch { /* dialog may be unavailable very early */ }
}
process.on('uncaughtException', reportStartupError);
process.on('unhandledRejection', reportStartupError);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    // Frameless on BOTH platforms so our custom titlebar is the only chrome
    // and looks identical on Windows and macOS. Hidden traffic lights on mac.
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0d0d12',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Avoid a white flash: reveal only once the first paint is ready.
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // External links open in the user's real browser, never a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ---------------- Window control IPC (custom titlebar) ---------------- */
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:toggle-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

app.whenReady().then(() => {
  prepareBinaries();
  ipcHandle = ipc.init(() => mainWindow);
  createWindow();
  ipcHandle.startClipboardWatchIfEnabled();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Resolve the maximize/restore icon state for the renderer if it asks.
ipcMain.handle('window:is-maximized', () => !!mainWindow?.isMaximized());

// A tool, not a background service: closing the window quits everywhere.
app.on('window-all-closed', () => app.quit());
