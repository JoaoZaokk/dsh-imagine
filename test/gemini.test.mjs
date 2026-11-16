import test from 'node:test';
import assert from 'node:assert/strict';
import { createGemini } from '../lib/gemini.js';
import { fromGoogle, retrySeconds, redact } from '../lib/errors.js';
import { isWav, wavSeconds, pcmToWav, imageSize, rateFromMime } from '../lib/wav.js';
import { PNG, WAV } from './helpers.mjs';

const reply = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const client = (fetch, key = 'secret-key-123') => createGemini({ getKey: () => key, fetch });

test('image: reads inlineData images and the caption text', async () => {
  let seen;
  const gemini = client(async (url, init) => {
    seen = { url, init };
    return reply(200, { candidates: [{ content: { parts: [{ text: 'Aqui está' }, { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] })();
  });
  const out = await gemini.generateImage({ prompt: 'um barco', model: 'gemini-3.1-flash-image', aspectRatio: '16:9' });
  assert.equal(out.images.length, 1);
  assert.deepEqual(out.images[0].bytes, PNG);
  assert.equal(out.text, 'Aqui está');
  assert.match(seen.url, /models\/gemini-3\.1-flash-image:generateContent$/);
  assert.equal(seen.init.headers['x-goog-api-key'], 'secret-key-123');
  assert.ok(!seen.url.includes('secret-key'), 'the key must not be in the URL');
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  assert.equal(body.generationConfig.imageConfig.aspectRatio, '16:9');
});

test('image: a safety block is "blocked", not "upstream"', async () => {
  const gemini = client(reply(200, { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }));
  await assert.rejects(gemini.generateImage({ prompt: 'x', model: 'm' }), { code: 'blocked', status: 422 });
  const finish = client(reply(200, { candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] }));
  await assert.rejects(finish.generateImage({ prompt: 'x', model: 'm' }), { code: 'blocked' });
});

test('image: an empty answer without a reason is an upstream problem', async () => {
  const gemini = client(reply(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'sem imagem' }] } }] }));
  await assert.rejects(gemini.generateImage({ prompt: 'x', model: 'm' }), { code: 'upstream' });
});

test('quota error carries the retry time and never the key', async () => {
  const message = 'You exceeded your current quota. key=secret-key-123 Please retry in 4h36m54.109543233s.';
  const gemini = client(reply(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message } }));
  const error = await gemini.generateImage({ prompt: 'x', model: 'm' }).catch((e) => e);
  assert.equal(error.code, 'quota');
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterSeconds, 4 * 3600 + 36 * 60 + 55);
  assert.ok(!JSON.stringify(error.toJSON()).includes('secret-key'));
});

test('retrySeconds understands the shapes Google uses', () => {
  assert.equal(retrySeconds('Please retry in 16s.'), 16);
  assert.equal(retrySeconds('retry in 1m30s'), 90);
  assert.equal(retrySeconds('nothing here'), undefined);
  assert.equal(fromGoogle(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'x', details: [{ retryDelay: '33s' }] } }).retryAfterSeconds, 33);
});

test('bad key: 400 "API key not valid", 401 and 403 all become badKey', () => {
  assert.equal(fromGoogle(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }).code, 'badKey');
  assert.equal(fromGoogle(401, { error: { message: 'x' } }).code, 'badKey');
  assert.equal(fromGoogle(403, { error: { message: 'x' } }).code, 'badKey');
  assert.equal(fromGoogle(400, { error: { message: 'Invalid JSON payload' } }).code, 'badRequest');
  assert.equal(fromGoogle(500, { error: { message: 'boom' } }).code, 'upstream');
  assert.equal(fromGoogle(503, { error: { message: 'boom' } }).status, 502);
});

test('redact hides key-shaped text', () => {
  assert.equal(redact('GET /x?key=abcDEF123&a=1'), 'GET /x?key=<hidden>&a=1');
  assert.ok(!redact('token AIzaSyA1234567890123456789012345678901').includes('AIza'));
});

test('depleted prepaid credit is "billing", not a rate limit', async () => {
  const body = { error: { code: 402, status: 'RESOURCE_EXHAUSTED', message: 'Your prepayment credits are depleted. Please go to AI Studio.' } };
  const gemini = client(reply(402, body));
  await assert.rejects(gemini.speak({ text: 'oi', model: 'm' }), { code: 'billing', status: 402 });
  assert.equal(fromGoogle(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'Your prepayment credits are depleted.' } }).code, 'billing');
  assert.equal(fromGoogle(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' } }).code, 'quota');
});

test('no key configured is "notConfigured" and nothing is sent', async () => {
  let called = false;
  const gemini = createGemini({ getKey: () => undefined, fetch: async () => { called = true; } });
  await assert.rejects(gemini.speak({ text: 'oi', model: 'm' }), { code: 'notConfigured', status: 503 });
  assert.equal(called, false);
});

test('network failure is "upstream" and does not leak the URL', async () => {
  const gemini = client(async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); });
  const error = await gemini.speak({ text: 'oi', model: 'm' }).catch((e) => e);
  assert.equal(error.code, 'upstream');
  assert.match(error.message, /ENOTFOUND/);
});

test('speech: WAV from the model passes through untouched', async () => {
  const gemini = client(reply(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: WAV.toString('base64') } }] } }] }));
  const out = await gemini.speak({ text: 'oi', model: 'm', voice: 'Puck', style: 'com calma' });
  assert.deepEqual(out, WAV);
});

test('speech: raw PCM is wrapped as WAV at the rate in the mime type', async () => {
  const pcm = Buffer.alloc(32000);
  let sent;
  const gemini = client(async (_url, init) => {
    sent = JSON.parse(init.body);
    return reply(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=16000', data: pcm.toString('base64') } }] } }] })();
  });
  const out = await gemini.speak({ text: 'oi', model: 'm', voice: 'Puck', style: 'calmly' });
  assert.ok(isWav(out));
  assert.equal(wavSeconds(out), 1);
  assert.equal(sent.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
  assert.match(sent.contents[0].parts[0].text, /^Say calmly: oi$/);
  assert.deepEqual(sent.generationConfig.responseModalities, ['AUDIO']);
});

test('transcribe: understands audioTranscription parts and plain text parts', async () => {
  const a = client(reply(200, { candidates: [{ content: { parts: [{ audioTranscription: { text: 'olá' } }] } }] }));
  assert.equal(await a.transcribe({ audio: WAV, mimeType: 'audio/wav', model: 'm' }), 'olá');
  const b = client(reply(200, { candidates: [{ content: { parts: [{ text: 'mundo ' }, { thought: true, text: 'pensando' }] } }] }));
  assert.equal(await b.transcribe({ audio: WAV, mimeType: 'audio/wav', model: 'm' }), 'mundo');
});

test('transcribe: sends the audio inline and names the language', async () => {
  let sent;
  const gemini = client(async (_u, init) => { sent = JSON.parse(init.body); return reply(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'x' }] } }] })(); });
  await gemini.transcribe({ audio: WAV, mimeType: 'audio/wav', model: 'm', language: 'pt-BR' });
  const parts = sent.contents[0].parts;
  assert.match(parts[0].text, /pt-BR/);
  assert.equal(parts[1].inlineData.mimeType, 'audio/wav');
  assert.equal(parts[1].inlineData.data, WAV.toString('base64'));
});

test('transcribe: silence (STOP with no text) is an empty transcript, not an error', async () => {
  const gemini = client(reply(200, { candidates: [{ finishReason: 'STOP', content: { parts: [] } }] }));
  assert.equal(await gemini.transcribe({ audio: WAV, mimeType: 'audio/wav', model: 'm' }), '');
});

test('wav helpers', () => {
  assert.equal(wavSeconds(WAV), 1);
  assert.equal(wavSeconds(Buffer.from('nope')), undefined);
  assert.equal(rateFromMime('audio/L16;codec=pcm;rate=24000'), 24000);
  assert.equal(rateFromMime('audio/wav'), 24000);
  assert.deepEqual(imageSize(PNG), { width: 1, height: 1 });
  assert.equal(imageSize(Buffer.from('xxxx')), undefined);
  assert.equal(pcmToWav(Buffer.alloc(0)).length, 44);
});

test('check: lists one model with the key in a header, and says nothing when the key is good', async () => {
  let seen;
  const gemini = client(async (url, init) => { seen = { url, init }; return reply(200, { models: [] })(); });
  assert.equal(await gemini.check(), undefined);
  assert.match(String(seen.url), /\/models\?pageSize=1$/);
  assert.equal(seen.init.headers['x-goog-api-key'], 'secret-key-123');
  assert.ok(!String(seen.url).includes('secret-key-123'), 'the key never goes in the URL');
});

test('check: a key Google refuses is badKey, an empty account is billing, a missing key is notConfigured', async () => {
  const bad = client(reply(400, { error: { status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } }));
  await assert.rejects(() => bad.check(), (e) => e.code === 'badKey');
  const broke = client(reply(402, { error: { message: 'Your prepayment credits are depleted.' } }));
  await assert.rejects(() => broke.check(), (e) => e.code === 'billing');
  const none = createGemini({ getKey: async () => undefined, fetch: async () => { throw new Error('must not call'); } });
  await assert.rejects(() => none.check(), (e) => e.code === 'notConfigured');
  const down = client(async () => { throw new Error('offline'); });
  await assert.rejects(() => down.check(), (e) => e.code === 'upstream');
});
