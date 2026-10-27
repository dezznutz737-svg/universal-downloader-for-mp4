// yt-dlp wrapper: fetch metadata for a URL, and download at maximum quality as
// MP4 or MP3. Everything is spawned with an argument ARRAY — never a shell
// string — because the URL is untrusted input. URLs are validated to http(s)
// and always passed after a `--` end-of-options separator so a crafted
// "--option-looking" URL can't inject flags.
const path = require('path');
const { spawn } = require('child_process');
const { bin } = require('./binaries');

// Sanitise a user-supplied output filename: strip path separators, characters
// illegal on Windows/macOS, yt-dlp template markers (%), control chars, and
// leading dots/dashes. Never lets the name escape the output directory.
function sanitizeOutName(name) {
  const s = String(name)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/%/g, ' ')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\-]+/, '')
    .slice(0, 180)
    .trim();
  return s || 'download';
}

// ---- URL validation ----
function assertValidUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\/[^\s]+$/i.test(url.trim())) {
    throw new Error('That doesn’t look like a valid link.');
  }
  return url.trim();
}

function browserCookieArgs(browser) {
  // Only use browser cookies when the user explicitly enables Edge in Settings.
  return browser === 'edge' ? ['--cookies-from-browser', 'edge'] : [];
}

// ---- Platform identity (label + brand colour var name) ----
const PLATFORMS = {
  youtube: { label: 'YouTube', color: 'youtube' },
  youtu: { label: 'YouTube', color: 'youtube' },
  tiktok: { label: 'TikTok', color: 'tiktok' },
  twitch: { label: 'Twitch', color: 'twitch' },
  twitchclips: { label: 'Twitch', color: 'twitch' },
  instagram: { label: 'Instagram', color: 'instagram' },
  twitter: { label: 'X', color: 'twitter' },
  x: { label: 'X', color: 'twitter' },
  soundcloud: { label: 'SoundCloud', color: 'soundcloud' },
  facebook: { label: 'Facebook', color: 'facebook' },
};
function identifyPlatform(info) {
  const key = String(info.extractor_key || info.extractor || '').toLowerCase();
  for (const k of Object.keys(PLATFORMS)) {
    if (key.startsWith(k)) return PLATFORMS[k];
  }
  return { label: info.extractor_key || 'Web', color: 'generic' };
}

// ---- Metadata fetch ----
// Returns a compact, renderer-friendly object (never the giant raw JSON).
function fetchInfo(url, { cookieBrowser = 'none' } = {}) {
  const clean = assertValidUrl(url);
  return new Promise((resolve, reject) => {
    const args = [
      '-J',              // dump a single JSON object
      '--no-playlist',   // a pasted video link, not its playlist
      '--no-warnings',
      ...browserCookieArgs(cookieBrowser),
      '--',
      clean,
    ];
    const child = spawn(bin('yt-dlp'), args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`Could not run yt-dlp: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(friendlyError(err)));
      let info;
      try {
        info = JSON.parse(out);
      } catch {
        return reject(new Error('Could not read the media info for that link.'));
      }
      resolve(summarize(info, clean));
    });
  });
}

function summarize(info, url) {
  const platform = identifyPlatform(info);
  // Distinct video heights actually available, best first.
  const heights = [
    ...new Set(
      (info.formats || [])
        .filter((f) => f.vcodec && f.vcodec !== 'none' && f.height)
        .map((f) => f.height)
    ),
  ].sort((a, b) => b - a);
  return {
    url,
    id: info.id,
    title: info.title || info.id || 'Untitled',
    uploader: info.uploader || info.channel || info.uploader_id || '',
    duration: info.duration || null, // seconds
    thumbnail: bestThumb(info),
    platform: platform.label,
    platformColor: platform.color,
    isAudioOnly: !heights.length && info.acodec && info.acodec !== 'none',
    heights, // e.g. [2160, 1440, 1080, 720, 480]
    isLive: !!info.is_live,
  };
}

function bestThumb(info) {
  if (info.thumbnail) return info.thumbnail;
  const thumbs = info.thumbnails || [];
  if (!thumbs.length) return null;
  return thumbs[thumbs.length - 1].url || null;
}

// ---- Download ----
// opts: { url, format:'mp4'|'mp3', quality:'best'|'2160'|..., outDir,
//         concurrentFragments, name? }
// callbacks: { onProgress(p), onStage(stage) }
// Returns { child, done: Promise<{ filepath }> } so the caller can cancel.
function download(opts, { onProgress, onStage } = {}) {
  const clean = assertValidUrl(opts.url);
  const outDir = opts.outDir;
  const frags = Math.max(1, Math.min(16, opts.concurrentFragments || 4));
  // Optional user-chosen filename; otherwise the video title + id.
  const nameTpl = opts.name ? sanitizeOutName(opts.name) : '%(title).200B [%(id)s]';

  const args = [
    '--no-playlist',
    '--no-warnings',
    ...browserCookieArgs(opts.cookieBrowser),
    '--newline',
    '--no-simulate',
    '--concurrent-fragments', String(frags),
    '-o', `${outDir}/${nameTpl}.%(ext)s`,
    // Machine-readable progress + the final path after post-processing.
    '--progress-template',
    'download:UD_P|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    '--print', 'after_move:UD_FILE %(filepath)s',
  ];

  // Point yt-dlp at our bundled ffmpeg/ffprobe. They live in a per-user bin dir
  // that is NOT on PATH, so without this yt-dlp can't merge video+audio or
  // extract audio — it would leave the streams as separate files.
  try {
    const ff = bin('ffmpeg');
    if (path.isAbsolute(ff)) args.push('--ffmpeg-location', path.dirname(ff));
  } catch { /* dev without bundled ffmpeg: fall back to PATH */ }

  if (opts.format === 'mp3') {
    // Best audio → MP3 at 320 kbps (no quality ceiling on the source).
    args.push('-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '320K');
  } else {
    const cap = opts.quality && opts.quality !== 'best' ? `[height<=${opts.quality}]` : '';
    // Prefer H.264 video + AAC audio so the MP4 plays and edits everywhere —
    // notably it imports into editors like Premiere Pro, which choke on VP9/AV1.
    // Fall back to the absolute best and remux to MP4 (stream copy, no re-encode)
    // only when H.264 isn't offered.
    args.push(
      '-f',
      `bv*[vcodec^=avc]${cap}+ba[acodec^=mp4a]/bv*[vcodec^=avc]${cap}+ba/bv*${cap}+ba/b${cap}`,
      '--merge-output-format', 'mp4'
    );
  }

  args.push('--', clean);

  const child = spawn(bin('yt-dlp'), args, { windowsHide: true });
  let finalPath = null;
  let errBuf = '';
  let lastStage = null;

  const handleLine = (line) => {
    line = line.trim();
    if (!line) return;
    if (line.startsWith('UD_FILE ')) {
      finalPath = line.slice('UD_FILE '.length).trim();
      return;
    }
    if (line.startsWith('UD_P|')) {
      const [, status, dl, total, est, speed, eta] = line.split('|');
      const totalBytes = num(total) || num(est);
      const downloaded = num(dl);
      const percent = totalBytes ? Math.min(100, (downloaded / totalBytes) * 100) : null;
      onProgress?.({
        percent,
        downloaded,
        total: totalBytes,
        speed: num(speed),
        eta: num(eta),
        status,
      });
      if (lastStage !== 'downloading') { lastStage = 'downloading'; onStage?.('downloading'); }
      return;
    }
    // Post-processing phases (merge / audio extract) — surface as a stage.
    if (/\[Merger\]/.test(line)) { lastStage = 'merging'; onStage?.('merging'); }
    else if (/\[ExtractAudio\]/.test(line)) { lastStage = 'converting'; onStage?.('converting'); }
    else if (/^\[download\] Destination|Deleting original/.test(line)) { /* noise */ }
  };

  bindLines(child.stdout, handleLine);
  child.stderr.on('data', (d) => (errBuf += d));

  const done = new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new Error(`Could not run yt-dlp: ${e.message}`)));
    child.on('close', (code, signal) => {
      if (signal || child.killed) return reject(Object.assign(new Error('Canceled'), { canceled: true }));
      if (code !== 0) return reject(new Error(friendlyError(errBuf)));
      resolve({ filepath: finalPath });
    });
  });

  return { child, done };
}

// ---- helpers ----
function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Split a stream into trimmed lines (yt-dlp uses \r for progress with --newline
// it emits \n, but fragment progress can still carry \r — handle both).
function bindLines(stream, onLine) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    const parts = buf.split(/\r\n|\r|\n/);
    buf = parts.pop();
    for (const p of parts) onLine(p);
  });
  stream.on('end', () => { if (buf) onLine(buf); });
}

function friendlyError(stderr) {
  const s = String(stderr);
  if (/Sign in to confirm|confirm you.{0,2}re not a bot/i.test(s)) {
    return 'YouTube needs sign-in verification. In Settings, choose Microsoft Edge under Browser cookies, then retry. You must be signed in to that video in Edge.';
  }
  if (/Unsupported URL|no suitable/i.test(s)) return 'That site or link isn’t supported.';
  if (/Private video|login required|This video is private/i.test(s)) return 'That media is private or needs a login.';
  if (/Video unavailable|not available|has been removed/i.test(s)) return 'That media is unavailable or was removed.';
  if (/HTTP Error 429|rate.limit/i.test(s)) return 'Rate-limited by the site. Try again shortly.';
  if (/geo.restricted|not available in your country/i.test(s)) return 'That media is geo-restricted.';
  // Fall back to the last meaningful yt-dlp error line.
  const line = s.split('\n').reverse().find((l) => /error/i.test(l));
  return (line || 'Download failed.').replace(/^ERROR:\s*/i, '').trim();
}

module.exports = { fetchInfo, download, assertValidUrl, identifyPlatform };
