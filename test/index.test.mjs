import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, keyReader, liveSettings, registerTools, resolveSettings, unwrap } from '../index.js';
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
    assert.equal(JSON.parse(r.body).version, '0.3.1');
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

test('tools: both are always registered, and a turned-off module hides its tool through `when`, live', async () => {
  const { dir, done } = tempDir();
  try {
    const live = { modules: { image: false, speech: true } };
    const settings = new Proxy({}, { get: (_, key) => resolveSettings(live)[key] });
    const defined = [];
    registerTools({ register: (t, options) => defined.push({ t, options }) }, (t) => t, { api: {}, store: createStore({ dir }), settings });
    assert.deepEqual(defined.map((d) => d.t.name), ['generate_image', 'speak']);
    const visible = (name) => defined.find((d) => d.t.name === name).options.when();
    assert.equal(visible('generate_image'), false);
    assert.equal(visible('speak'), true);
    live.modules.image = true; live.modules.speech = false;
    assert.equal(visible('generate_image'), true, 'turning a module on needs no restart');
    assert.equal(visible('speak'), false);
  } finally { done(); }
});

test('unwrap: the dsh hands volatile fields over as references; the plugin reads their current value', () => {
  const ref = (value) => ({ get: () => value });
  const live = { value: 'Puck' };
  const config = { modules: { image: ref(false), speech: ref(true) }, voice: { get: () => live.value }, dailyImageLimit: ref(7), apiKeyEnv: 'GEMINI_API_KEY', list: [ref(1), 2] };
  assert.deepEqual(unwrap(config), { modules: { image: false, speech: true }, voice: 'Puck', dailyImageLimit: 7, apiKeyEnv: 'GEMINI_API_KEY', list: [1, 2] });
  live.value = 'Zephyr';
  assert.equal(unwrap(config).voice, 'Zephyr', 'read again at each use, so an edit applies at once');
  assert.deepEqual(unwrap(undefined), undefined);
  assert.equal(unwrap(null), null);
});

test('liveSettings: every read sees the config as it is now, with the defaults filled in', () => {
  const state = { voice: 'Kore', modules: { image: true } };
  const config = { modules: { image: { get: () => state.modules.image } }, voice: { get: () => state.voice } };
  const settings = liveSettings(config);
  assert.equal(settings.voice, 'Kore');
  assert.equal(settings.modules.image, true);
  assert.equal(settings.modules.live, true, 'untouched modules keep their default');
  state.voice = 'Puck'; state.modules.image = false;
  assert.equal(settings.voice, 'Puck');
  assert.equal(settings.modules.image, false);
});

test('the store keeps as many as it is told right now, even when that number changes', () => {
  const { dir, done } = tempDir();
  try {
    let keep = 2;
    const store = createStore({ dir, keep: () => keep });
    for (let i = 0; i < 4; i++) store.add({ bytes: PNG, mime: 'image/png', prompt: `p${i}`, model: 'm' });
    assert.equal(store.list().items.length, 2);
    keep = 1;
    store.add({ bytes: PNG, mime: 'image/png', prompt: 'last', model: 'm' });
    assert.equal(store.list().items.length, 1, 'a lower limit applies from the next picture');
  } finally { done(); }
});
