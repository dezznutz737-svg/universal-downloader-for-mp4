/* ============================================================
   Universal Downloader — renderer logic

   Talks to the main process only through window.udl (preload).
   The renderer is sandboxed: no Node, no direct IPC. All user-
   supplied text (titles, filenames) is escaped before it touches
   innerHTML.
   ============================================================ */
'use strict';

const api = window.udl || null;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- client state ---------- */
const activeJobs = new Map(); // id -> job
let historyItems = [];        // newest first
let settings = null;
let currentInfo = null;       // last fetched preview info

/* =================================================================
   Navigation
   ================================================================= */
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${name}`));
  $$('.nav__item').forEach((n) => n.classList.toggle('is-active', n.dataset.view === name));
}
$$('.nav__item').forEach((item) => item.addEventListener('click', () => showView(item.dataset.view)));

/* Window controls */
$('#win-min')?.addEventListener('click', () => api?.window.minimize());
$('#win-max')?.addEventListener('click', () => api?.window.toggleMaximize());
$('#win-close')?.addEventListener('click', () => api?.window.close());

/* =================================================================
   Formatting helpers
   ================================================================= */
function fmtDuration(sec) {
  if (!sec && sec !== 0) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
function fmtBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function fmtSpeed(bps) { return bps ? `${fmtBytes(bps)}/s` : ''; }
function fmtEta(sec) {
  if (sec == null || sec < 0) return '';
  if (sec < 60) return `${Math.round(sec)}s left`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')} left`;
}
function fmtAgo(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} hr ago`;
  return `${Math.floor(d / 86400)} d ago`;
}
const FORMAT_LABEL = { mp4: 'MP4', mp3: 'MP3', wav: 'WAV', m4a: 'M4A', flac: 'FLAC' };

/* =================================================================
   Toasts
   ================================================================= */
const ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>',
  danger: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5M12 16h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16v-5M12 8h.01"/><circle cx="12" cy="12" r="9"/></svg>',
};
function toast({ title, msg = '', kind = 'success', action, timeout } = {}) {
  const stack = $('#toast-stack');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `
    <div class="toast__icon toast__icon--${kind}">${ICONS[kind] || ICONS.info}</div>
    <div class="toast__body">
      <div class="toast__title">${esc(title)}</div>
      ${msg ? `<div class="toast__msg">${esc(msg)}</div>` : ''}
    </div>
    ${action ? `<button class="toast__action">${esc(action.label)}</button>` : ''}`;
  const dismiss = () => {
    el.classList.add('is-leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  };
  if (action) $('.toast__action', el).addEventListener('click', () => { action.onClick?.(); dismiss(); });
  stack.appendChild(el);
  setTimeout(dismiss, timeout ?? (action ? 7000 : 4000));
}

/* =================================================================
   Download: fetch preview
   ================================================================= */
const urlInput = $('#url-input');
const elPreview = $('#preview');
const elSkeleton = $('#preview-skeleton');
const elError = $('#preview-error');
let fetchSeq = 0;

function isUrl(v) { return /^https?:\/\/[^\s]+$/i.test((v || '').trim()); }

function resetPreview() {
  elPreview.hidden = true;
  elSkeleton.hidden = true;
  elError.hidden = true;
  currentInfo = null;
}

async function fetchInfo(url) {
  if (!isUrl(url)) { resetPreview(); return; }
  const seq = ++fetchSeq;
  elPreview.hidden = true;
  elError.hidden = true;
  elSkeleton.hidden = false;
  elSkeleton.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const info = await api.info.fetch(url);
    if (seq !== fetchSeq) return; // a newer request superseded this one
    currentInfo = info;
    renderPreview(info);
  } catch (e) {
    if (seq !== fetchSeq) return;
    elSkeleton.hidden = true;
    elPreview.hidden = true;
    $('#preview-error-msg').textContent = e.message || 'Could not fetch that link.';
    elError.hidden = false;
  }
}

function renderPreview(info) {
  elSkeleton.hidden = true;
  elError.hidden = true;

  $('#pv-thumb').src = info.thumbnail || '';
  $('#pv-thumb').style.visibility = info.thumbnail ? 'visible' : 'hidden';
  const dur = fmtDuration(info.duration);
  $('#pv-duration').textContent = dur;
  $('#pv-duration').style.display = dur ? '' : 'none';
  $('#pv-title').textContent = info.title;
  $('#pv-platform').textContent = info.platform;
  $('#pv-platform-dot').style.background = `var(--p-${info.platformColor})`;
  $('#pv-uploader').textContent = info.uploader || info.platform;

  // Quality options from the real available heights.
  const sel = $('#quality-select');
  sel.innerHTML = '';
  const best = document.createElement('option');
  best.value = 'best';
  best.textContent = info.heights?.length ? `Best available (${info.heights[0]}p)` : 'Best available';
  sel.appendChild(best);
  for (const h of info.heights || []) {
    const o = document.createElement('option');
    o.value = String(h);
    o.textContent = `${h}p`;
    sel.appendChild(o);
  }

  // Prefill the editable filename with the title.
  $('#pv-filename').value = info.title || '';

  // Default format from settings; audio-only sources force MP3.
  const forceAudio = info.isAudioOnly || !(info.heights?.length);
  setFormat(forceAudio ? 'mp3' : (settings?.defaultFormat || 'mp4'));
  $('#format-seg button[data-format="mp4"]').disabled = forceAudio;

  elPreview.hidden = false;
  elPreview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setFormat(fmt) {
  $$('#format-seg button').forEach((b) => b.classList.toggle('is-active', b.dataset.format === fmt));
  const audio = fmt === 'mp3';
  $('#quality-opt').style.opacity = audio ? '0.4' : '1';
  $('#quality-select').disabled = audio;
  $('#pv-ext').textContent = audio ? '.mp3' : '.mp4';
}
$$('#format-seg button').forEach((b) =>
  b.addEventListener('click', () => { if (!b.disabled) setFormat(b.dataset.format); }));

/* Paste + auto-detect */
async function pasteFromClipboard() {
  let text = '';
  try { text = api ? await api.clipboard.read() : await navigator.clipboard.readText(); } catch {}
  if (text) { urlInput.value = text.trim(); fetchInfo(urlInput.value); }
  urlInput.focus();
}
$('#paste-btn')?.addEventListener('click', pasteFromClipboard);

let urlTimer;
urlInput?.addEventListener('input', () => {
  clearTimeout(urlTimer);
  const v = urlInput.value.trim();
  if (!isUrl(v)) { resetPreview(); return; }
  urlTimer = setTimeout(() => fetchInfo(v), 400);
});
urlInput?.addEventListener('paste', () => setTimeout(() => fetchInfo(urlInput.value.trim()), 0));

/* Start download */
$('#download-btn')?.addEventListener('click', async () => {
  if (!currentInfo) return;
  const format = $('#format-seg button.is-active')?.dataset.format || 'mp4';
  const quality = $('#quality-select').value || 'best';
  const typed = $('#pv-filename').value.trim();
  // Only send a custom name when the user actually changed it from the title.
  const name = typed && typed !== (currentInfo.title || '') ? typed : null;
  try {
    await api.download.start({
      url: currentInfo.url,
      format,
      quality,
      name,
      meta: {
        title: currentInfo.title,
        uploader: currentInfo.uploader,
        thumbnail: currentInfo.thumbnail,
        platform: currentInfo.platform,
        platformColor: currentInfo.platformColor,
        duration: currentInfo.duration,
      },
    });
    toast({ title: 'Added to queue', msg: currentInfo.title, kind: 'info',
      action: { label: 'View', onClick: () => showView('queue') } });
    urlInput.value = '';
    resetPreview();
  } catch (e) {
    toast({ title: 'Could not start download', msg: e.message, kind: 'danger' });
  }
});

/* =================================================================
   Convert
   ================================================================= */
const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((e) =>
  dz?.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add('is-over'); }));
['dragleave', 'drop'].forEach((e) =>
  dz?.addEventListener(e, (ev) => { ev.preventDefault(); if (e !== 'dragleave' || ev.target === dz) dz.classList.remove('is-over'); }));

dz?.addEventListener('drop', (ev) => {
  const files = [...(ev.dataTransfer?.files || [])];
  const paths = files.map((f) => { try { return api.files.pathFor(f); } catch { return null; } }).filter(Boolean);
  if (paths.length) addConversions(paths);
});
// Prevent the window from navigating when a file is dropped outside the zone.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('#browse-btn')?.addEventListener('click', async () => {
  const paths = await api.dialog.pickFiles();
  if (paths?.length) addConversions(paths);
});

async function addConversions(paths) {
  const target = $('#convert-target').value;
  try {
    await api.convert.add(paths, target);
    toast({ title: `Converting ${paths.length} file${paths.length > 1 ? 's' : ''}`, msg: `to ${FORMAT_LABEL[target]}`, kind: 'info' });
  } catch (e) {
    toast({ title: 'Could not start conversion', msg: e.message, kind: 'danger' });
  }
}

/* =================================================================
   Queue + history rendering
   ================================================================= */
function platformChip(job) {
  if (!job.platform || job.type === 'convert') return '';
  return `<span class="chip" style="height:20px"><span class="chip__dot" style="background:var(--p-${job.platformColor || 'generic'})"></span>${esc(job.platform)}</span>`;
}
const AUDIO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>';
const VIDEO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2.5"/><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none"/></svg>';
const FOLDER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-7.5l-2-2H4a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1Z"/></svg>';
const X_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function isAudioJob(job) {
  const f = job.type === 'download' ? job.format : job.target;
  return ['mp3', 'wav', 'm4a', 'flac'].includes(f);
}

function thumbHTML(job) {
  if (job.thumbnail) return `<img class="row__thumb" src="${esc(job.thumbnail)}" alt="" />`;
  return `<div class="row__thumb row__thumb--icon">${isAudioJob(job) ? AUDIO_ICON : VIDEO_ICON}</div>`;
}

function activeRowHTML(job) {
  const fmt = FORMAT_LABEL[job.type === 'download' ? job.format : job.target] || '';
  const metaBits = [];
  if (job.type === 'download') {
    metaBits.push(`${fmt}${job.quality && job.quality !== 'best' && job.format !== 'mp3' ? ' ' + job.quality + 'p' : ''}`);
  } else {
    metaBits.push(`${job.sourceExt || ''} → ${fmt}`);
  }

  let stageText = '';
  let indeterminate = false;
  if (job.status === 'queued') { stageText = 'Queued'; }
  else if (job.stage === 'merging') { stageText = 'Merging…'; indeterminate = true; }
  else if (job.stage === 'converting') { stageText = 'Converting…'; indeterminate = job.percent == null; }
  else if (job.status === 'error') { stageText = job.error || 'Failed'; }
  else {
    const parts = [];
    if (job.speed) parts.push(fmtSpeed(job.speed));
    if (job.eta != null) parts.push(fmtEta(job.eta));
    stageText = parts.join(' · ') || 'Starting…';
  }

  const pct = job.percent != null ? Math.round(job.percent) : null;
  const showBar = job.status !== 'queued' && job.status !== 'error';
  const barClass = 'progress' + ((indeterminate || (showBar && pct == null)) ? ' progress--indeterminate' : '');

  const right = job.status === 'error'
    ? `<button class="btn btn--icon" data-remove="${job.id}" title="Dismiss">${X_ICON}</button>`
    : `<span class="row__pct">${pct != null && !indeterminate ? pct + '%' : ''}</span>
       <button class="btn btn--icon" data-cancel="${job.id}" title="Cancel">${X_ICON}</button>`;

  return `<div class="row" data-job="${job.id}">
    ${thumbHTML(job)}
    <div class="row__main">
      <div class="row__title">${esc(job.title)}</div>
      <div class="row__meta">
        ${platformChip(job)}
        ${metaBits.map((b) => `<span>${esc(b)}</span>`).join('<span class="sep">·</span>')}
        <span class="sep">·</span><span${job.status === 'error' ? ' style="color:var(--danger)"' : ''}>${esc(stageText)}</span>
      </div>
      ${showBar ? `<div class="row__progress ${barClass}"><div class="progress__fill" style="${indeterminate ? '' : `width:${pct || 0}%`}"></div></div>` : ''}
    </div>
    <div class="row__right">${right}</div>
  </div>`;
}

function historyRowHTML(item) {
  const fmt = FORMAT_LABEL[item.format] || (item.format || '').toUpperCase();
  const meta = [fmt, fmtAgo(item.completedAt)].filter(Boolean);
  return `<div class="row" data-hist="${item.id}">
    ${item.thumbnail
      ? `<img class="row__thumb" src="${esc(item.thumbnail)}" alt="" />`
      : `<div class="row__thumb row__thumb--icon">${['mp3','wav','m4a','flac'].includes(item.format) ? AUDIO_ICON : VIDEO_ICON}</div>`}
    <div class="row__main">
      <div class="row__title">${esc(item.title)}</div>
      <div class="row__meta">
        <span class="status-dot status-dot--done"></span>
        ${meta.map((m) => `<span>${esc(m)}</span>`).join('<span class="sep">·</span>')}
      </div>
    </div>
    <div class="row__right">
      <button class="btn btn--ghost btn--sm" data-open="${esc(item.filepath || '')}">Open</button>
      <button class="btn btn--icon btn--sm" data-reveal="${esc(item.filepath || '')}" title="Show in folder">${FOLDER_ICON}</button>
    </div>
  </div>`;
}

function renderAll() {
  const active = [...activeJobs.values()].sort((a, b) => a.createdAt - b.createdAt);

  // Queue view — active only (with empty state)
  $('#active-rows').innerHTML = active.map(activeRowHTML).join('');
  $('#active-empty').style.display = active.length ? 'none' : '';

  // History view
  $('#history-rows').innerHTML = historyItems.map(historyRowHTML).join('');
  $('#history-empty').style.display = historyItems.length ? 'none' : '';

  // Convert view — convert-type jobs (active + recent history)
  const convActive = active.filter((j) => j.type === 'convert');
  const convHist = historyItems.filter((h) => h.type === 'convert').slice(0, 12);
  const convSection = $('#convert-section');
  convSection.hidden = convActive.length === 0 && convHist.length === 0;
  $('#convert-count').textContent = `${convActive.length + convHist.length}`;
  $('#convert-rows').innerHTML =
    convActive.map(activeRowHTML).join('') + convHist.map(historyRowHTML).join('');

  // Sidebar badge
  $('#queue-badge').textContent = active.length ? String(active.length) : '';
}

/* Delegated actions on rows */
async function openOrReveal(fn, p) {
  if (!p) return toast({ title: 'File unavailable', msg: 'No saved file for this item.', kind: 'danger' });
  const res = await fn(p);
  if (res && res.ok === false) toast({ title: 'Could not open', msg: res.error, kind: 'danger' });
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-cancel],[data-remove],[data-open],[data-reveal]');
  if (!t) return;
  if (t.dataset.cancel) api.queue.cancel(t.dataset.cancel);
  else if (t.dataset.remove) api.queue.remove(t.dataset.remove);
  else if (t.dataset.open) openOrReveal(api.files.open, t.dataset.open);
  else if (t.dataset.reveal) openOrReveal(api.files.reveal, t.dataset.reveal);
});

$('#clear-history')?.addEventListener('click', async () => {
  await api.history.clear();
  historyItems = [];
  renderAll();
});

/* Live engine events */
if (api) {
  api.on('queue:update', (job) => {
    if (job.status === 'done') { activeJobs.delete(job.id); }
    else { activeJobs.set(job.id, job); }
    renderAll();
  });
  api.on('queue:removed', (id) => { activeJobs.delete(id); renderAll(); });
  api.on('history:add', (entry) => {
    historyItems.unshift(entry);
    activeJobs.delete(entry.id);
    renderAll();
    toast({ title: 'Done', msg: entry.title, kind: 'success',
      action: { label: 'Open', onClick: () => api.files.open(entry.filepath) } });
  });
  api.on('clipboard:link', (url) => {
    toast({ title: 'Link copied', msg: 'Download it?', kind: 'info',
      action: { label: 'Download', onClick: () => { showView('download'); urlInput.value = url; fetchInfo(url); } } });
  });
}

/* =================================================================
   Settings
   ================================================================= */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $$('#theme-seg button').forEach((b) => b.classList.toggle('is-active', b.dataset.theme === theme));
}

async function loadSettings() {
  if (!api) return;
  settings = await api.settings.get();
  applyTheme(settings.theme || 'dark');
  $('#folder-path').textContent = settings.downloadFolder || '';
  $$('#set-format button').forEach((b) => b.classList.toggle('is-active', b.dataset.format === settings.defaultFormat));
  $('#set-quality').value = settings.defaultQuality || 'best';
  $('#set-concurrency').value = String(settings.concurrency || 3);
  $('#set-clipboard').checked = !!settings.watchClipboard;
}

async function patchSettings(patch) {
  settings = await api.settings.set(patch);
}

$('#change-folder')?.addEventListener('click', async () => {
  const dir = await api.dialog.pickFolder();
  if (dir) { await patchSettings({ downloadFolder: dir }); $('#folder-path').textContent = dir; }
});
$$('#set-format button').forEach((b) =>
  b.addEventListener('click', () => {
    $$('#set-format button').forEach((x) => x.classList.remove('is-active'));
    b.classList.add('is-active');
    patchSettings({ defaultFormat: b.dataset.format });
  }));
$('#set-quality')?.addEventListener('change', (e) => patchSettings({ defaultQuality: e.target.value }));
$('#set-concurrency')?.addEventListener('change', (e) => patchSettings({ concurrency: parseInt(e.target.value, 10) }));
$('#set-clipboard')?.addEventListener('change', (e) => patchSettings({ watchClipboard: e.target.checked }));
$$('#theme-seg button').forEach((b) =>
  b.addEventListener('click', () => { applyTheme(b.dataset.theme); patchSettings({ theme: b.dataset.theme }); }));

$('#update-ytdlp')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const r = await api.engine.updateYtDlp();
    toast({ title: r.updated ? 'yt-dlp updated' : 'yt-dlp is up to date', msg: r.message, kind: r.ok ? 'success' : 'danger' });
    loadEngine();
  } catch (err) {
    toast({ title: 'Update failed', msg: err.message, kind: 'danger' });
  } finally { btn.disabled = false; btn.textContent = 'Check for updates'; }
});

async function loadEngine() {
  if (!api) return;
  try {
    const v = await api.engine.versions();
    $('#ytdlp-chip').textContent = v.ytdlp || 'not found';
    $('#ytdlp-desc').textContent = v.ytdlp
      ? `${v.ytdlp} · keeps downloads working when sites change`
      : 'Keeps downloads working when sites change';
    $('#ffmpeg-chip').textContent = v.ffmpeg || 'not found';
    if (v.app) $('#app-version').textContent = `v${v.app}`;
    $('#engine-status-text').innerHTML = v.ytdlp
      ? `yt-dlp <b style="color:var(--success)">ready</b>`
      : `yt-dlp <b style="color:var(--danger)">missing</b>`;
  } catch {
    $('#engine-status-text').textContent = 'Engine unavailable';
  }
}

/* =================================================================
   Keyboard shortcuts
   ================================================================= */
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key >= '1' && e.key <= '5') {
    showView(['download', 'convert', 'queue', 'history', 'settings'][+e.key - 1]);
    e.preventDefault();
  }
});

/* =================================================================
   Boot
   ================================================================= */
async function boot() {
  if (!api) { console.log('Universal Downloader: running in browser preview (no backend).'); return; }
  await loadSettings();
  loadEngine();
  try {
    const [active, hist] = await Promise.all([api.queue.list(), api.history.list()]);
    active.forEach((j) => activeJobs.set(j.id, j));
    historyItems = hist || [];
    renderAll();
  } catch (e) { console.error('Boot state load failed:', e); }
  urlInput?.focus();
}
boot();
