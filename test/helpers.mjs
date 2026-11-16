import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createStore } from '../lib/store.js';
import { createHandler } from '../lib/handler.js';
import { resolveSettings } from '../index.js';
import { pcmToWav } from '../lib/wav.js';

/** A 1x1 PNG and a short WAV: real bytes, so size and duration parsing are exercised. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
export const WAV = pcmToWav(Buffer.alloc(48000), 24000); // 1 second

export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'imagine-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A Gemini stand-in that records its calls. */
export function fakeGemini(over = {}) {
  const calls = [];
  return {
    calls,
    async generateImage(args) {
      calls.push(['image', args]);
      return { images: [{ mime: 'image/png', bytes: PNG }], text: 'ok' };
    },
    async speak(args) {
      calls.push(['speak', args]);
      return WAV;
    },
    async transcribe(args) {
      calls.push(['transcribe', args]);
      return 'olá mundo';
    },
    ...over,
  };
}

/** Starts the handler on a real HTTP server and returns helpers to call it. */
export async function serve({ gemini = fakeGemini(), config = {}, hasKey = () => true, now } = {}) {
  const { dir, done } = tempDir();
  const settings = resolveSettings(config);
  const store = createStore({ dir, keep: settings.keep, ...(now ? { now } : {}) });
  const api = createHandler({ gemini, store, settings, hasKey, ...(now ? { now } : {}) });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    api.handle(req, res, url.pathname.replace(/^\/imagine\/?/, ''), url);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/imagine`;
  return {
    gemini,
    store,
    api,
    base,
    get: (path, init) => fetch(`${base}/${path}`, init),
    post: (path, body, headers = { 'content-type': 'application/json' }) =>
      fetch(`${base}/${path}`, { method: 'POST', headers, body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      done();
    },
  };
}
