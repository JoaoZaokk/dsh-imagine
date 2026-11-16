import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, keyReader, registerTools, resolveSettings } from '../index.js';
import { createHandler } from '../lib/handler.js';
import { createStore } from '../lib/store.js';
import { PNG, WAV, fakeGemini, tempDir } from './helpers.mjs';

function fakeCtx({ reject, withTools = false } = {}) {
  const registered = [];
  const tools = [];
  const ctx = {
    effect: (fn) => fn(),
    webServer: { register: (r) => registered.push(r) },
    connection: { requestRejection: () => reject },
  };
  if (withTools) ctx.tools = { register: (t) => tools.push(t) };
  return { ctx, registered, tools };
}
const res = () => ({ statusCode: 0, headers: {}, ended: false, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.ended = true; this.body = b; } });

test('the route is a prefix under /imagine and the login fence runs first', async () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  process.env.DSH_HOME = home;
  try {
    const { ctx, registered } = fakeCtx({ reject: 403 });
    apply(ctx, {});
    assert.equal(registered.length, 1);
    assert.equal(registered[0].kind, 'prefix');
    assert.equal(registered[0].path, '/imagine');
    const r = res();
    await registered[0].handler({ url: '/imagine/_status', method: 'GET', headers: {} }, r);
    assert.equal(r.statusCode, 403, 'rejected before anything else');
    assert.equal(r.body, undefined);
  } finally { rmSync(home, { recursive: true, force: true }); delete process.env.DSH_HOME; }
});

test('an accepted request reaches the handler', async () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  process.env.DSH_HOME = home;
  try {
    const { ctx, registered } = fakeCtx({});
    apply(ctx, {});
    const r = res();
    await registered[0].handler({ url: '/imagine/_status', method: 'GET', headers: {} }, r);
    assert.equal(r.statusCode, 200);
    assert.equal(JSON.parse(r.body).version, '0.2.0');
  } finally { rmSync(home, { recursive: true, force: true }); delete process.env.DSH_HOME; }
});

test('the key comes from the dsh credential store, then the environment, then a file, and is read each time', async () => {
  const home = mkdtempSync(join(tmpdir(), 'key-'));
  try {
    const file = join(home, 'gemini.key');
    const env = {};
    const read = keyReader({ apiKeyFile: file }, env);
    assert.equal(await read(), undefined);
    writeFileSync(file, '  from-file\n');
    assert.equal(await read(), 'from-file');
    env.GEMINI_API_KEY = ' from-env ';
    assert.equal(await read(), 'from-env');
    delete env.GEMINI_API_KEY;
    writeFileSync(file, 'rotated');
    assert.equal(await read(), 'rotated', 'a changed file is picked up without a restart');
    const custom = keyReader({ apiKeyEnv: 'MY_KEY', apiKeyFile: file }, { MY_KEY: 'custom' });
    assert.equal(await custom(), 'custom');

    // A key saved from the phone lives in the dsh store and outranks the environment and the file.
    const stored = { value: undefined };
    const credentials = { resolve: async (name) => (name === 'GEMINI_API_KEY' && stored.value ? { value: stored.value, source: 'stored' } : undefined) };
    const withStore = keyReader({ apiKeyFile: file }, { GEMINI_API_KEY: 'from-env' }, credentials);
    assert.equal(await withStore(), 'from-env', 'nothing stored yet: the environment answers');
    stored.value = '  from-phone ';
    assert.equal(await withStore(), 'from-phone');
    stored.value = undefined;
    assert.equal(await withStore(), 'from-env', 'removing the stored key falls back at once');
    const broken = keyReader({ apiKeyFile: file }, {}, { resolve: async () => { throw new Error('store down'); } });
    assert.equal(await broken(), 'rotated', 'a store that fails is the same as no key there');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('settings merge over the defaults', () => {
  const s = resolveSettings({ modules: { live: false }, models: { speech: 'other-tts' }, dailyImageLimit: 5 });
  assert.deepEqual(s.modules, { image: true, speech: true, transcribe: true, live: false });
  assert.equal(s.models.speech, 'other-tts');
  assert.equal(s.models.image, 'gemini-3.1-flash-image');
  assert.equal(s.dailyImageLimit, 5);
  assert.equal(resolveSettings({ dailyImageLimit: 'x' }).dailyImageLimit, 40);
});

test('tools: generate_image and speak register, run and write only inside the plugin folder', async () => {
  const { dir, done } = tempDir();
  try {
    const settings = resolveSettings({});
    const store = createStore({ dir });
    const gemini = fakeGemini();
    const api = createHandler({ gemini, store, settings, hasKey: () => true });
    const defined = [];
    registerTools({ register: (t) => defined.push(t) }, (t) => t, { api, store, settings });
    assert.deepEqual(defined.map((t) => t.name), ['generate_image', 'speak']);

    const image = defined[0];
    assert.equal(image.parameters.prompt.required, true);
    const out = await image.execute({ prompt: '  um barco  ', aspectRatio: '16:9' }, { signal: undefined });
    assert.equal(out.images.length, 1);
    assert.ok(out.images[0].path.startsWith(dir), 'inside the plugin folder');
    assert.ok(out.images[0].path.endsWith('.png'));
    assert.equal(gemini.calls[0][1].prompt, 'um barco');
    assert.match(image.output.render({}, out)[0].text, /Saved image\/png/);

    const speak = defined[1];
    const spoken = await speak.execute({ text: 'oi', voice: 'Puck' }, {});
    assert.ok(spoken.path.startsWith(dir) && spoken.path.endsWith('.wav'));
    assert.match(speak.output.render({}, spoken)[0].text, /Saved WAV/);

    await assert.rejects(image.execute({ prompt: '' }, {}), /prompt/);
  } finally { done(); }
});

test('tools: a turned-off module registers nothing', () => {
  const { dir, done } = tempDir();
  try {
    const settings = resolveSettings({ modules: { image: false, speech: false } });
    const defined = [];
    registerTools({ register: (t) => defined.push(t) }, (t) => t, { api: {}, store: createStore({ dir }), settings });
    assert.deepEqual(defined, []);
  } finally { done(); }
});
