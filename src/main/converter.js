// ffmpeg/ffprobe converter. Chooses the highest-quality path automatically:
// stream-copy (remux, zero loss) whenever the source codecs fit the target
// container, and only re-encodes the streams that genuinely can't be copied.
// Spawned with argument arrays; input paths come from the OS file picker /
// drag-drop, never assembled into a shell string.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { bin } = require('./binaries');

// target format → how to produce it
const TARGETS = {
  mp3: { kind: 'audio', ext: 'mp3', acodec: ['-c:a', 'libmp3lame', '-b:a', '320k'] },
  wav: { kind: 'audio', ext: 'wav', acodec: ['-c:a', 'pcm_s16le'] },
  m4a: { kind: 'audio', ext: 'm4a', acodec: ['-c:a', 'aac', '-b:a', '256k'] },
  flac: { kind: 'audio', ext: 'flac', acodec: ['-c:a', 'flac'] },
  mp4: { kind: 'video', ext: 'mp4' },
};

// Codecs that can be stream-copied into an MP4 container without re-encoding.
const MP4_VIDEO_OK = new Set(['h264', 'hevc', 'av1', 'vp9', 'mpeg4']);
const MP4_AUDIO_OK = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'alac']);

function probe(inputPath) {
  return new Promise((resolve, reject) => {
    execFile(
      bin('ffprobe'),
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', inputPath],
      { maxBuffer: 1 << 24 },
      (err, stdout) => {
        if (err) return reject(new Error('Could not read that file.'));
        try {
          const j = JSON.parse(stdout);
          const v = (j.streams || []).find((s) => s.codec_type === 'video' && s.codec_name !== 'mjpeg');
          const a = (j.streams || []).find((s) => s.codec_type === 'audio');
          resolve({
            duration: parseFloat(j.format?.duration) || 0,
            vcodec: v?.codec_name || null,
            acodec: a?.codec_name || null,
            hasVideo: !!v,
            hasAudio: !!a,
          });
        } catch {
          reject(new Error('Could not read that file.'));
        }
      }
    );
  });
}

// Non-colliding output path in the same folder as the source.
function outputPath(inputPath, ext) {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  let candidate = path.join(dir, `${base}.${ext}`);
  if (path.resolve(candidate) === path.resolve(inputPath)) candidate = path.join(dir, `${base} (converted).${ext}`);
  let n = 1;
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${base} (${n++}).${ext}`);
  return candidate;
}

async function buildArgs(inputPath, target, info) {
  const spec = TARGETS[target];
  const out = outputPath(inputPath, spec.ext);
  const args = ['-hide_banner', '-nostdin', '-y', '-i', inputPath];
  let remux = false;

  if (spec.kind === 'audio') {
    if (!info.hasAudio) throw new Error('That file has no audio track to extract.');
    args.push('-vn', '-map', '0:a:0', ...spec.acodec);
  } else {
    // MP4 video: copy each stream that fits the container, re-encode only what
    // doesn't. Pure remux when both already fit → zero quality loss.
    const vCopy = info.vcodec && MP4_VIDEO_OK.has(info.vcodec);
    const aCopy = !info.hasAudio || (info.acodec && MP4_AUDIO_OK.has(info.acodec));
    remux = vCopy && aCopy;
    args.push('-map', '0');
    args.push('-c:v', vCopy ? 'copy' : 'libx264', ...(vCopy ? [] : ['-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p']));
    if (info.hasAudio) args.push('-c:a', aCopy ? 'copy' : 'aac', ...(aCopy ? [] : ['-b:a', '256k']));
    args.push('-movflags', '+faststart');
  }

  args.push('-progress', 'pipe:1', '-nostats', out);
  return { args, out, remux };
}

// convert(opts, callbacks) → { child, done: Promise<{ filepath, remux }> }
// opts: { inputPath, target } ; callbacks: { onProgress({percent, speed}) }
async function convert(opts, { onProgress } = {}) {
  const spec = TARGETS[opts.target];
  if (!spec) throw new Error(`Unsupported output format: ${opts.target}`);
  if (!fs.existsSync(opts.inputPath)) throw new Error('That file no longer exists.');

  const info = await probe(opts.inputPath);
  const { args, out, remux } = await buildArgs(opts.inputPath, opts.target, info);
  const duration = info.duration;

  const child = spawn(bin('ffmpeg'), args, { windowsHide: true });
  let errBuf = '';
  let buf = '';

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const parts = buf.split('\n');
    buf = parts.pop();
    let percent = null;
    let speed = null;
    for (const line of parts) {
      const [k, v] = line.split('=');
      if (k === 'out_time_us' || k === 'out_time_ms') {
        const sec = parseInt(v, 10) / (k === 'out_time_us' ? 1e6 : 1e3);
        if (duration > 0) percent = Math.min(100, (sec / duration) * 100);
      } else if (k === 'speed') {
        const m = /([\d.]+)x/.exec(v);
        if (m) speed = parseFloat(m[1]);
      }
    }
    if (percent != null || speed != null) onProgress?.({ percent, speed });
  });
  child.stderr.on('data', (d) => (errBuf += d));

  const done = new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new Error(`Could not run ffmpeg: ${e.message}`)));
    child.on('close', (code, signal) => {
      if (signal || child.killed) {
        try { fs.existsSync(out) && fs.unlinkSync(out); } catch { /* ignore */ }
        return reject(Object.assign(new Error('Canceled'), { canceled: true }));
      }
      if (code !== 0) {
        const line = String(errBuf).split('\n').filter(Boolean).pop() || 'Conversion failed.';
        return reject(new Error(line.trim()));
      }
      resolve({ filepath: out, remux });
    });
  });

  return { child, done };
}

module.exports = { convert, probe, TARGETS };
