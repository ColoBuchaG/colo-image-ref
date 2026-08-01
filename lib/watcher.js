import fs from 'node:fs';
import path from 'node:path';

// Linux does not provide recursive fs.watch, so keep one lightweight watcher
// per directory and rebuild the set after a debounced scan discovers changes.
export function createLibraryWatcher(roots, onChange, options = {}) {
  const delay = Number(options.delay || 900);
  const watchers = new Map();
  let timer = null;
  let closed = false;

  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (closed) return;
      try {
        await onChange();
      } finally {
        refresh();
      }
    }, delay);
  };

  const refresh = () => {
    if (closed) return;
    const wanted = new Set();
    for (const root of roots()) collectDirectories(root, wanted);
    for (const [dir, watcher] of watchers) {
      if (!wanted.has(dir)) {
        watcher.close();
        watchers.delete(dir);
      }
    }
    for (const dir of wanted) {
      if (watchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, { persistent: false }, schedule);
        watcher.on('error', () => {
          watcher.close();
          watchers.delete(dir);
        });
        watchers.set(dir, watcher);
      } catch { /* inaccessible folders are ignored until the next refresh */ }
    }
  };

  refresh();
  return {
    refresh,
    close() {
      closed = true;
      clearTimeout(timer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
    get count() { return watchers.size; },
  };
}

function collectDirectories(root, out) {
  const stack = [path.resolve(root)];
  while (stack.length) {
    const dir = stack.pop();
    if (out.has(dir)) continue;
    out.add(dir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) stack.push(path.join(dir, entry.name));
    }
  }
}
