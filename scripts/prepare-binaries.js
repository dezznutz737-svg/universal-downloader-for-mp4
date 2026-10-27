// Fetch the bundled binaries into resources/ before packaging, for the CURRENT
// platform: yt-dlp, ffmpeg, and ffprobe. Each OS is built on its own machine
// (macOS locally, Windows via GitHub Actions), so we only ever fetch the
// current platform's binaries. Run automatically by `npm run build` /
// `build:win`. Pass --force to re-download.
//
//   macOS   → resources/{yt-dlp, ffmpeg, ffprobe}
//   Windows → resources/{yt-dlp.exe, ffmpeg.exe, ffprobe.exe}
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const isWin = process.platform === 'win32';
const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'resources');
const force = process.argv.includes('--force');
const exe = (n) => (isWin ? `${n}.exe` : n);

// Official standalone yt-dlp builds.
const YTDLP_URL = isWin
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) =>
      https.get(u, { headers: { 'User-Agent': 'udl-build' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          get(res.headers.location); // follow redirects (GitHub → CDN)
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed (${res.statusCode}) for ${u}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      });
    get(url).on('error', reject);
  });
}

async function ensureYtDlp() {
  const dest = path.join(RES, exe('yt-dlp'));
  if (!force && fs.existsSync(dest)) return console.log('yt-dlp already present, skipping.');
  console.log('Downloading yt-dlp…');
  await download(YTDLP_URL, dest);
  if (!isWin) fs.chmodSync(dest, 0o755);
  console.log('yt-dlp:', execFileSync(dest, ['--version']).toString().trim());
}

// ffmpeg + ffprobe come as a zip of static builds. BtbN publishes Windows;
// evermeet.cx publishes notarized macOS builds (one archive per tool).
async function ensureFfmpeg() {
  const haveBoth = fs.existsSync(path.join(RES, exe('ffmpeg'))) &&
    fs.existsSync(path.join(RES, exe('ffprobe')));
  if (!force && haveBoth) return console.log('ffmpeg + ffprobe already present, skipping.');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'udl-ff-'));
  if (isWin) {
    const url = 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';
    const zip = path.join(tmp, 'ffmpeg.zip');
    console.log('Downloading ffmpeg (win64)…');
    await download(url, zip);
    // Extract just the two exes from the archive's bin/ folder.
    execFileSync('tar', ['-xf', zip, '-C', tmp], { stdio: 'inherit' });
    const binDir = findFile(tmp, 'ffmpeg.exe');
    fs.copyFileSync(path.join(binDir, 'ffmpeg.exe'), path.join(RES, 'ffmpeg.exe'));
    fs.copyFileSync(path.join(binDir, 'ffprobe.exe'), path.join(RES, 'ffprobe.exe'));
  } else {
    for (const tool of ['ffmpeg', 'ffprobe']) {
      const url = `https://evermeet.cx/ffmpeg/getrelease/${tool}/zip`;
      const zip = path.join(tmp, `${tool}.zip`);
      console.log(`Downloading ${tool} (macOS)…`);
      await download(url, zip);
      execFileSync('unzip', ['-o', zip, '-d', tmp], { stdio: 'inherit' });
      const out = path.join(RES, tool);
      fs.copyFileSync(path.join(tmp, tool), out);
      fs.chmodSync(out, 0o755);
    }
  }
  console.log('ffmpeg:', execFileSync(path.join(RES, exe('ffmpeg')), ['-version']).toString().split('\n')[0]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Recursively locate the directory containing `name`.
function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    } else if (entry.name === name) {
      return dir;
    }
  }
  return null;
}

async function main() {
  fs.mkdirSync(RES, { recursive: true });
  await ensureYtDlp();
  await ensureFfmpeg();
  console.log('Binaries ready in resources/.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
