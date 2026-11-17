import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { extensionFor } from './wav.js';

const ID = /^[a-f0-9]{12}$/;

/**
 * What the plugin keeps on disk: every generated image and its prompt, newest first, in
 * `<dir>/index.json` and `<dir>/files/<id>.<ext>`. Ids are random hex, so a request can never
 * reach outside the folder.
 */
export function createStore({ dir, keep = 200, now = () => Date.now() }) {
  // `keep` is a number, or a function read at each prune, so the limit can be edited live.
  const limit = () => Math.max(1, Math.floor(typeof keep === 'function' ? keep() : keep));
  const files = join(dir, 'files');
  const indexPath = join(dir, 'index.json');
  mkdirSync(files, { recursive: true, mode: 0o700 });

  const read = () => {
    try {
      const list = JSON.parse(readFileSync(indexPath, 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  const write = (items) => {
    const temp = `${indexPath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(items), { mode: 0o600 });
    renameSync(temp, indexPath);
    try {
      chmodSync(indexPath, 0o600);
    } catch {
      // best effort
    }
  };
  const fileOf = (item) => join(files, `${item.id}.${extensionFor(item.mime)}`);

  return {
    isId: (value) => ID.test(String(value)),

    /** Saves bytes and returns the public item. */
    add({ bytes, mime, prompt, model, width, height }) {
      const id = randomBytes(6).toString('hex');
      const item = { id, mime, createdAt: now(), prompt, model, bytes: bytes.length, ...(width ? { width, height } : {}) };
      writeFileSync(fileOf(item), bytes, { mode: 0o600 });
      const items = [item, ...read()];
      for (const old of items.splice(limit())) rmSync(fileOf(old), { force: true });
      write(items);
      return item;
    },

    list({ limit = 50, offset = 0 } = {}) {
      const items = read();
      const page = items.slice(offset, offset + Math.max(1, Math.min(limit, 200)));
      return { items: page, hasMore: offset + page.length < items.length, total: items.length };
    },

    get(id) {
      if (!ID.test(String(id))) return undefined;
      const item = read().find((entry) => entry.id === id);
      if (!item || !existsSync(fileOf(item))) return undefined;
      return { item, path: fileOf(item), bytes: readFileSync(fileOf(item)) };
    },

    remove(id) {
      if (!ID.test(String(id))) return false;
      const items = read();
      const item = items.find((entry) => entry.id === id);
      if (!item) return false;
      rmSync(fileOf(item), { force: true });
      write(items.filter((entry) => entry.id !== id));
      return true;
    },

    /** Images made since the given time; used for the daily spending guard. */
    countSince(since) {
      return read().filter((item) => item.createdAt >= since).length;
    },

    /** Keeps a spoken WAV for the agent to pick up; returns its absolute path. Only the newest 50 stay. */
    addAudio(bytes) {
      const folder = join(dir, 'speech');
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const id = randomBytes(6).toString('hex');
      const path = join(folder, `${id}.wav`);
      writeFileSync(path, bytes, { mode: 0o600 });
      const names = readdirSync(folder).filter((name) => name.endsWith('.wav')).sort((a, b) => statSync(join(folder, b)).mtimeMs - statSync(join(folder, a)).mtimeMs);
      for (const old of names.slice(50)) rmSync(join(folder, old), { force: true });
      return path;
    },

    /** Absolute path of a saved image. */
    pathOf(item) {
      return fileOf(item);
    },

    pathFor(id) {
      return ID.test(String(id)) ? join(files, id) : undefined;
    },
    dir,
  };
}
