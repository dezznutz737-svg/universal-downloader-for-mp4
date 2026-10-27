// Generate Universal Downloader's app icon from scratch — a rounded-square with the brand
// gradient and a white "download" glyph — with zero dependencies (pure zlib
// PNG encoding). Produces build/icon.png (1024²). On macOS it also builds
// build/icon.icns via the system `iconutil`. Run with `npm run icon`.
//
// This is a clean, reproducible default so the repo always has a real icon;
// swap in custom artwork any time by replacing build/icon.png / icon.icns.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const SIZE = 1024;
const BUILD = path.join(__dirname, '..', 'build');

// ---- tiny vector helpers ----
const lerp = (a, b, t) => a + (b - a) * t;
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
// brand gradient stops (matches --accent-grad in the UI)
const STOPS = [
  [0.0, [0x7b, 0x6b, 0xff]],
  [0.55, [0x6c, 0x5c, 0xff]],
  [1.0, [0x8a, 0x5c, 0xff]],
];
function gradient(t) {
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1], [t1, c1] = STOPS[i];
      const k = (t - t0) / (t1 - t0 || 1);
      return [0, 1, 2].map((j) => Math.round(lerp(c0[j], c1[j], k)));
    }
  }
  return STOPS[STOPS.length - 1][1];
}

function renderRGBA() {
  const S = SIZE;
  const radius = S * 0.235;
  const stroke = S * 0.062;
  const half = stroke / 2;
  const cx = S / 2;
  // glyph geometry (normalised to S)
  const shaft = [cx, S * 0.27, cx, S * 0.60];
  const headL = [cx - S * 0.115, S * 0.475, cx, S * 0.60];
  const headR = [cx, S * 0.60, cx + S * 0.115, S * 0.475];
  const base = [S * 0.31, S * 0.73, S * 0.69, S * 0.73];

  const buf = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;

      // rounded-corner alpha (anti-aliased)
      let outside = 0;
      const corners = [
        [radius, radius], [S - radius, radius],
        [radius, S - radius], [S - radius, S - radius],
      ];
      for (const [ccx, ccy] of corners) {
        const inCornerBox = (x < radius && ccx === radius || x > S - radius && ccx === S - radius) &&
          (y < radius && ccy === radius || y > S - radius && ccy === S - radius);
        if (inCornerBox) outside = Math.max(outside, Math.hypot(x - ccx, y - ccy) - radius);
      }
      const alpha = Math.max(0, Math.min(1, 1 - outside)); // 1px AA feather

      // base gradient colour along the diagonal
      let [r, g, b] = gradient((x + y) / (2 * S));

      // glyph mask (white), anti-aliased against the stroke edge
      const d = Math.min(
        segDist(x, y, ...shaft), segDist(x, y, ...headL),
        segDist(x, y, ...headR), segDist(x, y, ...base)
      );
      const gm = Math.max(0, Math.min(1, half - d + 0.5));
      r = Math.round(lerp(r, 255, gm));
      g = Math.round(lerp(g, 255, gm));
      b = Math.round(lerp(b, 255, gm));

      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return buf;
}

// ---- minimal PNG encoder ----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  // add filter byte (0) per scanline
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function main() {
  fs.mkdirSync(BUILD, { recursive: true });
  console.log('Rendering icon…');
  const png = encodePNG(renderRGBA(), SIZE);
  const pngPath = path.join(BUILD, 'icon.png');
  fs.writeFileSync(pngPath, png);
  console.log('Wrote', pngPath, `(${(png.length / 1024).toFixed(0)} KB)`);

  // On macOS, assemble the .icns the dmg target expects.
  if (process.platform === 'darwin') {
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'udl-iconset-'));
      const iconset = path.join(tmp, 'icon.iconset');
      fs.mkdirSync(iconset);
      const sizes = [16, 32, 64, 128, 256, 512, 1024];
      for (const s of sizes) {
        execFileSync('sips', ['-z', String(s), String(s), pngPath, '--out',
          path.join(iconset, `icon_${s}x${s}.png`)], { stdio: 'ignore' });
        if (s <= 512) {
          execFileSync('sips', ['-z', String(s * 2), String(s * 2), pngPath, '--out',
            path.join(iconset, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' });
        }
      }
      execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD, 'icon.icns')]);
      fs.rmSync(tmp, { recursive: true, force: true });
      console.log('Wrote', path.join(BUILD, 'icon.icns'));
    } catch (e) {
      console.warn('icns generation skipped:', e.message);
    }
  }
}

main();
