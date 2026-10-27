// The job engine. Holds download + convert jobs, runs up to `concurrency` at
// once, and emits 'update' whenever a job changes so the renderer can reflect
// live progress. Completed jobs move into persistent history.
const { EventEmitter } = require('events');
const path = require('path');
const { randomUUID } = require('crypto');
const ytdlp = require('./ytdlp');
const converter = require('./converter');
const settings = require('./settings');
const history = require('./history');

class Queue extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();   // id -> job (active/queued/failed)
    this.children = new Map(); // id -> child process (for cancel)
    this.running = 0;
  }

  get concurrency() {
    return Math.max(1, settings.load().concurrency || 3);
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  _emit(job) {
    this.emit('update', job);
  }

  _add(job) {
    this.jobs.set(job.id, job);
    this._emit(job);
    this._pump();
    return job;
  }

  addDownload({ url, format, quality, name, meta = {} }) {
    return this._add({
      id: randomUUID(),
      type: 'download',
      url,
      format: format === 'mp3' ? 'mp3' : 'mp4',
      quality: quality || 'best',
      name: name || null,
      title: (name && name.trim()) || meta.title || url,
      uploader: meta.uploader || '',
      thumbnail: meta.thumbnail || null,
      platform: meta.platform || 'Web',
      platformColor: meta.platformColor || 'generic',
      duration: meta.duration || null,
      status: 'queued',
      stage: null,
      percent: null,
      speed: null,
      eta: null,
      createdAt: Date.now(),
    });
  }

  addConvert({ inputPath, target }) {
    return this._add({
      id: randomUUID(),
      type: 'convert',
      inputPath,
      target,
      title: path.basename(inputPath),
      sourceExt: path.extname(inputPath).replace('.', '').toUpperCase(),
      status: 'queued',
      stage: null,
      percent: null,
      speed: null,
      createdAt: Date.now(),
    });
  }

  _pump() {
    if (this.running >= this.concurrency) return;
    const next = this.list().find((j) => j.status === 'queued');
    if (!next) return;
    this.running++;
    next.status = 'running';
    this._emit(next);
    (next.type === 'download' ? this._runDownload(next) : this._runConvert(next))
      .catch(() => {}) // errors already recorded on the job
      .finally(() => {
        this.running--;
        this.children.delete(next.id);
        this._pump();
      });
    // Fill remaining slots.
    this._pump();
  }

  async _runDownload(job) {
    const cfg = settings.load();
    try {
      const { child, done } = ytdlp.download(
        {
          url: job.url,
          format: job.format,
          quality: job.quality,
          name: job.name,
          outDir: cfg.downloadFolder,
          concurrentFragments: cfg.concurrentFragments,
        },
        {
          onProgress: (p) => {
            job.percent = p.percent;
            job.speed = p.speed;
            job.eta = p.eta;
            if (job.stage !== 'downloading') job.stage = 'downloading';
            this._emit(job);
          },
          onStage: (stage) => { job.stage = stage; if (stage !== 'downloading') { job.percent = null; } this._emit(job); },
        }
      );
      this.children.set(job.id, child);
      const { filepath } = await done;
      this._complete(job, filepath);
    } catch (e) {
      this._fail(job, e);
    }
  }

  async _runConvert(job) {
    try {
      const { child, done } = await converter.convert(
        { inputPath: job.inputPath, target: job.target },
        {
          onProgress: (p) => {
            if (p.percent != null) job.percent = p.percent;
            job.speed = p.speed;
            job.stage = 'converting';
            this._emit(job);
          },
        }
      );
      this.children.set(job.id, child);
      const { filepath } = await done;
      this._complete(job, filepath);
    } catch (e) {
      this._fail(job, e);
    }
  }

  _complete(job, filepath) {
    job.status = 'done';
    job.stage = null;
    job.percent = 100;
    job.filepath = filepath;
    this._emit(job);
    const entry = {
      id: job.id,
      type: job.type,
      title: filepath ? path.basename(filepath) : job.title,
      filepath,
      format: job.type === 'download' ? job.format : job.target,
      platform: job.platform || null,
      platformColor: job.platformColor || null,
      thumbnail: job.thumbnail || null,
      completedAt: Date.now(),
    };
    history.add(entry);
    this.emit('history', entry);
    // Drop from the active map shortly after so the UI can animate it out.
    this.jobs.delete(job.id);
  }

  _fail(job, err) {
    if (err && err.canceled) {
      job.status = 'canceled';
    } else {
      job.status = 'error';
      job.error = err?.message || 'Something went wrong.';
    }
    job.stage = null;
    this._emit(job);
  }

  cancel(id) {
    const child = this.children.get(id);
    const job = this.jobs.get(id);
    if (child) killTree(child);
    if (job && job.status === 'queued') this._fail(job, Object.assign(new Error('Canceled'), { canceled: true }));
  }

  remove(id) {
    this.cancel(id);
    if (this.jobs.delete(id)) this.emit('removed', id);
  }
}

// Kill yt-dlp/ffmpeg and any fragment children. On Windows a plain kill leaves
// child fragment downloaders orphaned, so use taskkill /T.
function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawnTaskkill(child.pid);
    } else {
      child.kill('SIGTERM');
    }
    child.killed = true;
  } catch { /* already gone */ }
}
function spawnTaskkill(pid) {
  const { spawn } = require('child_process');
  spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
}

module.exports = new Queue();
