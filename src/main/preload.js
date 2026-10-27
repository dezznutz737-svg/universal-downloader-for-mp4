// Preload — the only bridge between the sandboxed renderer and Node/Electron.
// Every capability the UI has is an explicit, named channel here; the renderer
// never gets raw ipcRenderer or Node access.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Whitelisted push channels the main process can send to the renderer.
const EVENTS = ['queue:update', 'queue:removed', 'history:add', 'clipboard:link'];

contextBridge.exposeInMainWorld('udl', {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  },

  info: {
    fetch: (url) => ipcRenderer.invoke('info:fetch', url),
  },

  download: {
    start: (opts) => ipcRenderer.invoke('download:start', opts),
  },

  convert: {
    add: (paths, target) => ipcRenderer.invoke('convert:add', { paths, target }),
    targets: () => ipcRenderer.invoke('convert:targets'),
  },

  queue: {
    list: () => ipcRenderer.invoke('queue:list'),
    cancel: (id) => ipcRenderer.invoke('queue:cancel', id),
    remove: (id) => ipcRenderer.invoke('queue:remove', id),
  },

  history: {
    list: () => ipcRenderer.invoke('history:list'),
    remove: (id) => ipcRenderer.invoke('history:remove', id),
    clear: () => ipcRenderer.invoke('history:clear'),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },

  dialog: {
    pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
    pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  },

  files: {
    open: (p) => ipcRenderer.invoke('file:open', p),
    reveal: (p) => ipcRenderer.invoke('file:reveal', p),
    // Resolve a dropped File to its absolute path (the supported Electron API;
    // File.path was removed in recent versions).
    pathFor: (file) => webUtils.getPathForFile(file),
  },

  clipboard: {
    read: () => ipcRenderer.invoke('clipboard:read'),
  },

  engine: {
    versions: () => ipcRenderer.invoke('engine:versions'),
    updateYtDlp: () => ipcRenderer.invoke('ytdlp:update'),
  },

  // Subscribe to a push channel. Returns an unsubscribe function.
  on: (channel, cb) => {
    if (!EVENTS.includes(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
