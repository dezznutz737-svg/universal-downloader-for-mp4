// All renderer-facing IPC. Handlers are the only surface the sandboxed UI can
// reach; each is a named, explicit channel. Queue progress is pushed to the
// window as it happens.
const fs = require('fs');
const { ipcMain, dialog, shell, clipboard, app } = require('electron');
const { execFile } = require('child_process');
const ytdlp = require('./ytdlp');
const converter = require('./converter');
const queue = require('./queue');
const settings = require('./settings');
const history = require('./history');
const { bin, verifyBinary } = require('./binaries');

function init(getWindow) {
  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // Push engine events to the renderer.
  queue.on('update', (job) => send('queue:update', job));
  queue.on('removed', (id) => send('queue:removed', id));
  queue.on('history', (entry) => send('history:add', entry));

  // ---- Metadata ----
  ipcMain.handle('info:fetch', (_e, url) => ytdlp.fetchInfo(url));

  // ---- Downloads ----
  ipcMain.handle('download:start', (_e, opts) => queue.addDownload(opts));

  // ---- Conversions ----
  ipcMain.handle('convert:add', (_e, { paths, target }) => {
    const list = (paths || []).map((inputPath) => queue.addConvert({ inputPath, target }));
    return list;
  });
  ipcMain.handle('convert:targets', () => Object.keys(converter.TARGETS));

  // ---- Queue / history ----
  ipcMain.handle('queue:list', () => queue.list());
  ipcMain.handle('queue:cancel', (_e, id) => queue.cancel(id));
  ipcMain.handle('queue:remove', (_e, id) => queue.remove(id));
  ipcMain.handle('history:list', () => history.all());
  ipcMain.handle('history:remove', (_e, id) => history.remove(id));
  ipcMain.handle('history:clear', () => history.clear());

  // ---- Settings ----
  ipcMain.handle('settings:get', () => settings.load());
  ipcMain.handle('settings:set', (_e, patch) => {
    const next = settings.save(patch || {});
    if ('watchClipboard' in (patch || {})) toggleClipboardWatch(next.watchClipboard, send);
    return next;
  });

  // ---- OS integration ----
  ipcMain.handle('dialog:pickFolder', async () => {
    const win = getWindow();
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:pickFiles', async () => {
    const win = getWindow();
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'flv', 'm4v', 'wav', 'm4a', 'flac', 'mp3', 'aac', 'ogg', 'opus', 'wma'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('file:open', async (_e, p) => {
    if (!p || !fs.existsSync(p)) return { ok: false, error: 'File not found — it may have been moved or deleted.' };
    const err = await shell.openPath(p); // returns '' on success, else message
    return err ? { ok: false, error: err } : { ok: true };
  });
  ipcMain.handle('file:reveal', (_e, p) => {
    if (!p || !fs.existsSync(p)) return { ok: false, error: 'File not found — it may have been moved or deleted.' };
    shell.showItemInFolder(p);
    return { ok: true };
  });
  ipcMain.handle('clipboard:read', () => clipboard.readText());

  // ---- Engine info / updates ----
  ipcMain.handle('engine:versions', async () => {
    const [yt, ff] = await Promise.all([
      verifyBinary(bin('yt-dlp')).catch(() => ({ ok: false })),
      probeFfmpegVersion().catch(() => null),
    ]);
    return { ytdlp: yt.ok ? yt.version : null, ffmpeg: ff, app: app.getVersion() };
  });
  ipcMain.handle('ytdlp:update', () => updateYtDlp());

  return {
    // Called once at startup if the user has clipboard watching on.
    startClipboardWatchIfEnabled: () => toggleClipboardWatch(settings.load().watchClipboard, send),
  };
}

function probeFfmpegVersion() {
  return new Promise((resolve, reject) => {
    execFile(bin('ffmpeg'), ['-version'], (err, stdout) => {
      if (err) return reject(err);
      const m = /ffmpeg version (\S+)/.exec(String(stdout));
      resolve(m ? m[1] : String(stdout).split('\n')[0]);
    });
  });
}

// yt-dlp self-update. The staged binary lives in a writable per-user dir, so
// `-U` can overwrite itself. Critical because sites break older versions.
function updateYtDlp() {
  return new Promise((resolve) => {
    execFile(bin('yt-dlp'), ['-U'], { timeout: 120000 }, (err, stdout, stderr) => {
      const out = String(stdout) + String(stderr);
      if (err && !/already up.?to.?date/i.test(out)) {
        return resolve({ ok: false, message: out.trim().split('\n').pop() || err.message });
      }
      const updated = /Updated yt-dlp to/i.test(out);
      const m = /(?:Updated yt-dlp to|yt-dlp is up to date \()\s*([^)\s]+)/i.exec(out);
      resolve({ ok: true, updated, message: out.trim().split('\n').filter(Boolean).pop() || 'Up to date', version: m ? m[1] : null });
    });
  });
}

// ---- Clipboard watching ----
let clipTimer = null;
let lastClip = '';
function toggleClipboardWatch(enabled, send) {
  if (clipTimer) { clearInterval(clipTimer); clipTimer = null; }
  if (!enabled) return;
  lastClip = clipboard.readText(); // don't fire for whatever's already copied
  clipTimer = setInterval(() => {
    const text = clipboard.readText().trim();
    if (text && text !== lastClip && /^https?:\/\/[^\s]+$/i.test(text) && text.length < 2048) {
      lastClip = text;
      send('clipboard:link', text);
    } else if (text !== lastClip) {
      lastClip = text;
    }
  }, 1000);
}

module.exports = { init };
