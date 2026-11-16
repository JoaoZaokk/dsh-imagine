import test from 'node:test';
import assert from 'node:assert/strict';
import { ImagineError } from '../lib/errors.js';
import { PNG, WAV, fakeGemini, serve } from './helpers.mjs';

test('_status says what is configured, with models and voices', async () => {
  const s = await serve({ hasKey: () => true });
  try {
    const body = await (await s.get('_status')).json();
    assert.equal(body.configured, true);
    assert.equal(body.version, '0.2.0');
    assert.deepEqual(body.modules, { image: true, speech: true, transcribe: true, live: true });
    assert.equal(body.models.image, 'gemini-3.1-flash-image');
    assert.ok(body.voices.includes('Kore'));
    assert.ok(body.imageModels.length >= 2);
  } finally { await s.close(); }
  const off = await serve({ hasKey: () => false });
  try { assert.equal((await (await off.get('_status')).json()).configured, false); } finally { await off.close(); }
});

test('image: creates, stores, lists, serves and deletes', async () => {
  const s = await serve();
  try {
    const res = await s.post('image', { prompt: 'um barco', aspectRatio: '16:9' });
    assert.equal(res.status, 200);
    const { items } = await res.json();
    assert.equal(items.length, 1);
    assert.equal(items[0].mime, 'image/png');
    assert.equal(items[0].prompt, 'um barco');
    assert.equal(items[0].width, 1);
    assert.deepEqual(s.gemini.calls[0][1].aspectRatio, '16:9');

    const history = await (await s.get('history')).json();
    assert.equal(history.items.length, 1);
    assert.equal(history.hasMore, false);

    const file = await s.get(`file/${items[0].id}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);

    const del = await s.get(`history/${items[0].id}`, { method: 'DELETE' });
    assert.deepEqual(await del.json(), { ok: true });
    assert.equal((await s.get(`file/${items[0].id}`)).status, 404);
    assert.equal((await s.get(`history/${items[0].id}`, { method: 'DELETE' })).status, 404);
  } finally { await s.close(); }
});

test('image: count makes several, capped at 4', async () => {
  const s = await serve();
  try {
    const { items } = await (await s.post('image', { prompt: 'x', count: 3 })).json();
    assert.equal(items.length, 3);
    const many = await (await s.post('image', { prompt: 'x', count: 99 })).json();
    assert.equal(many.items.length, 4);
  } finally { await s.close(); }
});

test('image: validates the request', async () => {
  const s = await serve();
  try {
    for (const [body, fragment] of [
      [{}, 'prompt'],
      [{ prompt: '   ' }, 'prompt'],
      [{ prompt: 'x'.repeat(4001) }, 'too long'],
      [{ prompt: 'x', model: 'gpt-4' }, 'Unknown image model'],
      [{ prompt: 'x', aspectRatio: '7:3' }, 'aspect'],
    ]) {
      const res = await s.post('image', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      const json = await res.json();
      assert.equal(json.error.code, 'badRequest');
      assert.ok(json.error.message.includes(fragment), json.error.message);
    }
    assert.equal((await s.post('image', '[1,2]')).status, 400);
    assert.equal((await s.post('image', 'not json')).status, 400);
    assert.equal(s.gemini.calls.length, 0, 'nothing reached Gemini');
  } finally { await s.close(); }
});

test('image: Google errors keep their code and status', async () => {
  const quota = new ImagineError('quota', 'limit 0', { retryAfterSeconds: 60 });
  const s = await serve({ gemini: fakeGemini({ generateImage: async () => { throw quota; } }) });
  try {
    const res = await s.post('image', { prompt: 'x' });
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: { code: 'quota', message: 'limit 0', retryAfterSeconds: 60 } });
  } finally { await s.close(); }
  const odd = await serve({ gemini: fakeGemini({ generateImage: async () => { throw new TypeError('boom'); } }) });
  try {
    const res = await odd.post('image', { prompt: 'x' });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, 'upstream');
  } finally { await odd.close(); }
});

test('daily limit stops a runaway agent before it spends', async () => {
  const s = await serve({ config: { dailyImageLimit: 2 } });
  try {
    assert.equal((await s.post('image', { prompt: 'a', count: 2 })).status, 200);
    const res = await s.post('image', { prompt: 'b' });
    assert.equal(res.status, 429);
    assert.match((await res.json()).error.message, /daily limit of 2/);
    assert.equal(s.gemini.calls.length, 2);
  } finally { await s.close(); }
});

test('history pages', async () => {
  const s = await serve();
  try {
    for (let i = 0; i < 3; i++) await s.post('image', { prompt: `p${i}` });
    const first = await (await s.get('history?limit=2&offset=0')).json();
    assert.equal(first.items.length, 2);
    assert.equal(first.hasMore, true);
    assert.equal(first.items[0].prompt, 'p2', 'newest first');
    const second = await (await s.get('history?limit=2&offset=2')).json();
    assert.equal(second.items.length, 1);
    assert.equal(second.hasMore, false);
    assert.equal((await (await s.get('history?limit=abc&offset=-5')).json()).items.length, 3);
  } finally { await s.close(); }
});

test('files: ids that are not ours never touch the disk', async () => {
  const s = await serve();
  try {
    for (const id of ['..', '..%2F..%2Fetc%2Fpasswd', 'abcdefabcdef.png', 'ABCDEFABCDEF', '']) {
      const res = await s.get(`file/${id}`);
      assert.ok([404].includes(res.status), `${id} -> ${res.status}`);
    }
    assert.equal((await s.get('file/aaaaaaaaaaaa')).status, 404);
  } finally { await s.close(); }
});

test('speech: returns WAV bytes and validates voice and text', async () => {
  const s = await serve();
  try {
    const res = await s.post('speech', { text: 'olá', voice: 'Puck', style: 'calmamente' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/wav');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), WAV);
    const call = s.gemini.calls.at(-1)[1];
    assert.equal(call.voice, 'Puck');
    assert.equal(call.style, 'calmamente');
    assert.equal(call.model, 'gemini-3.8-flash-tts');
    assert.equal((await s.post('speech', { text: 'x', voice: 'Nope' })).status, 400);
    assert.equal((await s.post('speech', { text: '' })).status, 400);
    assert.equal((await s.post('speech', { text: 'x'.repeat(5001) })).status, 400);
  } finally { await s.close(); }
});

test('transcribe: raw audio in, text out; the m4a mime is normalised', async () => {
  const s = await serve();
  try {
    const res = await s.post('transcribe?language=pt', WAV, { 'content-type': 'audio/wav' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: 'olá mundo', model: 'gemini-3.5-transcribe', seconds: 1 });
    assert.equal(s.gemini.calls.at(-1)[1].language, 'pt');
    await s.post('transcribe', Buffer.from('abc'), { 'content-type': 'audio/x-m4a' });
    assert.equal(s.gemini.calls.at(-1)[1].mimeType, 'audio/mp4');
    assert.equal(s.gemini.calls.at(-1)[1].language, undefined);
  } finally { await s.close(); }
});

test('transcribe: refuses what is not audio, empty or huge', async () => {
  const s = await serve();
  try {
    assert.equal((await s.post('transcribe', WAV, { 'content-type': 'application/json' })).status, 400);
    assert.equal((await s.post('transcribe', WAV, {})).status, 400);
    assert.equal((await s.post('transcribe', Buffer.alloc(0), { 'content-type': 'audio/wav' })).status, 400);
    const bad = await s.post('transcribe?language=../../x', WAV, { 'content-type': 'audio/wav' });
    assert.equal(bad.status, 200);
    assert.equal(s.gemini.calls.at(-1)[1].language, undefined, 'a strange language is dropped, not forwarded');
  } finally { await s.close(); }
});

test('a module that is off answers 404 and never calls Gemini', async () => {
  const s = await serve({ config: { modules: { image: false, speech: false, transcribe: false } } });
  try {
    assert.equal((await s.post('image', { prompt: 'x' })).status, 404);
    assert.equal((await s.get('history')).status, 404);
    assert.equal((await s.post('speech', { text: 'x' })).status, 404);
    assert.equal((await s.post('transcribe', WAV, { 'content-type': 'audio/wav' })).status, 404);
    assert.equal(s.gemini.calls.length, 0);
    assert.equal((await (await s.get('_status')).json()).modules.image, false);
  } finally { await s.close(); }
});

test('unknown routes and wrong methods', async () => {
  const s = await serve();
  try {
    assert.equal((await s.get('nope')).status, 404);
    assert.equal((await s.get('image')).status, 404);
    assert.equal((await s.post('_status', {})).status, 405);
  } finally { await s.close(); }
});

test('check: POST /check answers ok when the key works and the plugin error when it does not', async () => {
  const good = await serve({ gemini: fakeGemini({ async check() {} }) });
  try {
    const res = await good.post('check', {});
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally { await good.close(); }
  const bad = await serve({ gemini: fakeGemini({ async check() { throw new ImagineError('badKey', 'API key not valid.'); } }) });
  try {
    const res = await bad.post('check', {});
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'badKey');
  } finally { await bad.close(); }
});
