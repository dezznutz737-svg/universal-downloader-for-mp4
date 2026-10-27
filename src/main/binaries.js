// Staging + resolution for the bundled command-line binaries
// (yt-dlp, ffmpeg, ffprobe).
//
// Binaries ship read-only inside the app bundle's resources. yt-dlp can't
// self-update there (`-U` overwrites its own file), and a freshly packaged
// binary may lack the exec bit or carry macOS quarantine. So on launch we copy
// each into a writable per-user dir, fix its mode, strip quarantine, and hand
// out the resolved paths. In dev (before `prepare-binaries` has run) there's no
// bundled copy, so we fall back to whatever is on PATH.
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const isWin = process.platform === 'win32';
const exe = (n) => (isWin ? `${n}.exe` : n);

// name = filename in resources / the writable bin dir; key = how callers ask.
const BINARIES = [
  { key: 'yt-dlp', name: exe('yt-dlp'), selfUpdates: true },
  { key: 'ffmpeg', name: exe('ffmpeg'), selfUpdates: false },
  { key: 'ffprobe', name: exe('ffprobe'), selfUpdates: false },
];

let resolved = null; // { 'yt-dlp': '/path'|null, ffmpeg, ffprobe }
let userBinDir = null;

function stageOne({ name }, resourcesDir, binDir) {
  const source = path.join(resourcesDir, name);
  // No bundled copy (e.g. `npm run dev` before binaries are downloaded):
  // leave unresolved so callers fall back to a PATH lookup by bare name.
  if (!fs.existsSync(source)) return isOnPath(name) ? name : null;

  const dest = path.join(binDir, name);
  fs.mkdirSync(binDir, { recursive: true });

  // Copy only when missing, so a user's self-updated yt-dlp survives app
  // restarts and updates instead of being clobbered by the older bundled copy.
  if (!fs.existsSync(dest)) fs.copyFileSync(source, dest);

  if (!isWin) {
    fs.chmodSync(dest, 0o755);
    try {
      // Files we write ourselves aren't normally quarantined, but clear it
      // defensively; ignore failure (attribute simply absent).
      execFileSync('xattr', ['-dr', 'com.apple.quarantine', dest]);
    } catch { /* nothing to clear */ }
  }
  return dest;
}

// Cheap PATH probe so dev machines with a global yt-dlp/ffmpeg still work.
function isOnPath(name) {
  try {
    execFileSync(isWin ? 'where' : 'which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy bundled binaries into userDataDir/bin and resolve their paths.
 * Idempotent — safe to call once at startup.
 */
function stageBinaries({ resourcesDir, userDataDir }) {
  userBinDir = path.join(userDataDir, 'bin');
  resolved = {};
  for (const bin of BINARIES) {
    resolved[bin.key] = stageOne(bin, resourcesDir, userBinDir);
  }
  return resolved;
}

// Path to a staged binary by key ('yt-dlp' | 'ffmpeg' | 'ffprobe').
// Throws if unavailable so callers surface a clear error instead of spawning
// an undefined path.
function bin(key) {
  const p = resolved && resolved[key];
  if (!p) throw new Error(`${key} is not available. Try reinstalling Universal Downloader.`);
  return p;
}

function binDir() {
  return userBinDir;
}

// Confirm a staged binary actually executes. ffmpeg/ffprobe use single-dash
// `-version`; yt-dlp uses `--version`.
function verifyBinary(binPath) {
  const isFf = /ff(mpeg|probe)(\.exe)?$/i.test(binPath);
  return new Promise((resolve) => {
    execFile(binPath, [isFf ? '-version' : '--version'], { timeout: 30000 }, (err, stdout) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true, version: String(stdout).trim().split('\n')[0] });
    });
  });
}

module.exports = { stageBinaries, verifyBinary, bin, binDir, BINARIES };
