<div align="center">
  <img src="build/icon.png" width="112" alt="Universal Downloader" />
  <h1>Universal Downloader</h1>
  <p><b>A universal media downloader &amp; converter.</b><br/>
  Paste any link — YouTube, TikTok, Instagram, X, Twitch, SoundCloud, and 1000+ more — and get it at maximum quality as MP4 or MP3. Convert local files with zero quality loss. Free, local, no accounts, no telemetry.</p>
</div>

---

## Download

Grab the latest installer from the [**Releases**](https://github.com/SnowwyHimself/universal-downloader/releases/latest) page:

- **Windows (x64)** — `Universal-Downloader-Windows-Setup.exe`
- **macOS (Apple Silicon)** — `Universal-Downloader-…-macOS-arm64.dmg`

> **macOS**: the app is ad-hoc signed (not notarized). On first launch, right-click the app → **Open**, or run `xattr -cr "/Applications/Universal Downloader.app"`.

## Features

- **Universal download** — one input field. Paste a link from anywhere yt-dlp supports; Universal Downloader auto-detects the platform and fetches a preview (thumbnail, title, uploader, duration, quality options).
- **Maximum quality, zero loss** — always grabs `bestvideo+bestaudio` and merges with ffmpeg, remuxing (no re-encode) whenever codecs allow. MP3 extraction at 320 kbps.
- **Converter** — drop in local files to change format: video→audio, video→video, audio→audio. Remux when possible, high-quality re-encode when not. Batch queue supported.
- **Live queue** — concurrent downloads/conversions with per-item progress (percent, speed, ETA, cancel) plus a history with *Open* / *Show in folder*.
- **Clipboard watch** — optionally offers to download when you copy a media link.
- **Fast &amp; responsive** — all yt-dlp/ffmpeg work runs in child processes; the UI never blocks. Concurrent fragment downloading for speed.
- **Cross-platform parity** — identical features and look on Windows and macOS: custom frameless title bar, bundled Inter font, styled scrollbars, dark &amp; light themes.

## Screenshots

> _Add screenshots to `docs/` and reference them here._

| Download | Queue |
| --- | --- |
| _`docs/download.png`_ | _`docs/queue.png`_ |

| Convert | Settings |
| --- | --- |
| _`docs/convert.png`_ | _`docs/settings.png`_ |

## Tech

- **Electron** + Node.js — clean `contextBridge` IPC, no embedded server.
- **yt-dlp** for downloading, with in-app self-update (sites break it constantly, so keeping it current is critical).
- **ffmpeg / ffprobe** for merging &amp; conversion.
- Binaries are downloaded per-platform at build time (`scripts/prepare-binaries.js`) and staged into a writable per-user dir on first launch so yt-dlp can self-update.
- All input passed to yt-dlp/ffmpeg via `spawn` argument arrays — never shell strings — since URLs are untrusted.

## Development

```bash
npm install
npm run dev        # launch the app (uses a system yt-dlp/ffmpeg on PATH if present)
```

The renderer (`src/renderer/`) is plain HTML/CSS/JS and degrades gracefully in a
normal browser for quick UI iteration.

## Building

Each OS is built on its own machine (macOS locally, Windows via CI). The build
first downloads the correct binaries for the current platform.

```bash
npm run icon        # (re)generate the app icon
npm run build       # macOS  → dist/*.dmg
npm run build:win   # Windows → dist/*Setup.exe (NSIS)
```

## Project layout

```
src/
  main/       Electron main process
    main.js       window + app lifecycle + window-control IPC
    preload.js    the only renderer↔main bridge (window.udl)
    binaries.js   stage & resolve yt-dlp / ffmpeg / ffprobe
  renderer/   UI (plain HTML/CSS/JS)
    index.html
    styles/       tokens · base · components · views
    js/app.js
    assets/fonts/ bundled Inter (identical rendering on Win + Mac)
scripts/      prepare-binaries · after-pack (mac ad-hoc sign) · make-placeholder-icon
```

## License

MIT — completely free, no paywall, no accounts, no telemetry.
