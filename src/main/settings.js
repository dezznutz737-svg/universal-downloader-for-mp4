// Persistent user settings + a small JSON store, saved under userData so they
// survive restarts and app updates. All local — no cloud, no telemetry.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let settingsPath;
let cache = null;

function defaults() {
  return {
    downloadFolder: app.getPath('downloads'),
    defaultFormat: 'mp4', // 'mp4' | 'mp3'
    defaultQuality: 'best', // 'best' | '2160' | '1440' | '1080' | '720' | '480'
    concurrency: 3,
    concurrentFragments: 4,
    theme: 'dark', // 'dark' | 'light'
    watchClipboard: false,
  };
}

function load() {
  if (cache) return cache;
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    cache = { ...defaults(), ...raw };
  } catch {
    cache = defaults();
  }
  // Migrate installs from the old auto-assigned "<Downloads>/Universal Downloader"
  // subfolder default to plain Downloads. Only touches the folder if it still
  // matches that old default (i.e. the user never picked one themselves).
  const legacyDefault = path.join(app.getPath('downloads'), 'Universal Downloader');
  if (cache.downloadFolder === legacyDefault) {
    cache.downloadFolder = app.getPath('downloads');
    try { fs.writeFileSync(settingsPath, JSON.stringify(cache, null, 2)); } catch { /* best effort */ }
  }
  ensureDownloadFolder(cache.downloadFolder);
  return cache;
}

function save(patch) {
  cache = { ...load(), ...patch };
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error('Failed to save settings:', e.message);
  }
  if (patch.downloadFolder) ensureDownloadFolder(patch.downloadFolder);
  return cache;
}

function ensureDownloadFolder(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch { /* best effort; download will surface a clear error if truly bad */ }
}

module.exports = { load, save, defaults };
