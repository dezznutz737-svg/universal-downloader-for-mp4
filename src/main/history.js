// Completed-item history, persisted to userData/history.json so finished
// downloads/conversions survive restarts (with their "Open" / "Show in folder"
// targets). Newest first, capped so the file can't grow without bound.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX = 200;
let filePath;
let items = null;

function load() {
  if (items) return items;
  filePath = path.join(app.getPath('userData'), 'history.json');
  try {
    items = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(items)) items = [];
  } catch {
    items = [];
  }
  return items;
}

function persist() {
  try {
    fs.writeFileSync(filePath, JSON.stringify(items, null, 2));
  } catch (e) {
    console.error('Failed to save history:', e.message);
  }
}

function all() {
  return load();
}

function add(entry) {
  load();
  items.unshift(entry);
  if (items.length > MAX) items.length = MAX;
  persist();
  return entry;
}

function remove(id) {
  load();
  items = items.filter((i) => i.id !== id);
  persist();
}

function clear() {
  items = [];
  persist();
}

module.exports = { all, add, remove, clear };
