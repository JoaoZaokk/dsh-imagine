// Real calls to Google: they run only when a key is present, and they cost a few cents.
//   GEMINI_API_KEY=... node --test test/live.e2e.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGemini } from '../lib/gemini.js';
import { openLive } from '../lib/live.js';
import { DEFAULTS, keyReader } from '../index.js';
import { isWav, wavSeconds } from '../lib/wav.js';

const key = await keyReader({})();
const skip = key ? false : 'no GEMINI_API_KEY';
const gemini = createGemini({ getKey: () => key });
const norm = (text) => text.toLowerCase().normalize('NFD').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

test('speech then transcription: what Gemini says, Gemini hears', { skip, timeout: 120000 }, async () => {
  const wav = await gemini.speak({ text: 'A aprovação pendente está esperando por você.', model: DEFAULTS.models.speech, voice: 'Aoede' });
  assert.ok(isWav(wav));
  assert.ok(wavSeconds(wav) > 1);
  const text = await gemini.transcribe({ audio: wav, mimeType: 'audio/wav', model: DEFAULTS.models.transcribe, language: 'pt' });
  assert.match(norm(text), /aprovacao pendente esta esperando/);
});

test('live: a text turn comes back as audio and a transcript', { skip, timeout: 90000 }, async () => {
  const chunks = [];
  let said = '';
  const done = Promise.withResolvers();
  const live = openLive({ key, model: DEFAULTS.models.live, onAudio: (p) => chunks.push(p), onText: (t, who) => { if (who === 'model') said += t; }, onTurnComplete: () => done.resolve(), onClose: () => done.resolve() });
  await live.opened;
  live.sendText('Diga apenas: pronto.');
  setTimeout(() => done.resolve(), 40000);
  await done.promise;
  live.close();
  assert.ok(Buffer.concat(chunks).length > 4000, 'audio came back');
  assert.match(norm(said), /pronto/);
});

test('a wrong key is a clean badKey error', { skip, timeout: 30000 }, async () => {
  const wrong = createGemini({ getKey: () => 'not-a-real-key' });
  await assert.rejects(wrong.speak({ text: 'oi', model: DEFAULTS.models.speech }), { code: 'badKey' });
});

test('check: the real key passes and a made-up one is badKey', { skip, timeout: 30000 }, async () => {
  assert.equal(await gemini.check(), undefined);
  const wrong = createGemini({ getKey: () => 'not-a-real-key' });
  await assert.rejects(wrong.check(), { code: 'badKey' });
});

test('live turns: a spoken question is answered aloud, and the session remembers the one before', { skip, timeout: 180000 }, async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, readFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createLiveSessions } = await import('../lib/live-sessions.js');
  const dir = mkdtempSync(join(tmpdir(), 'live-'));
  try {
    const say = async (text) => {
      const wav24 = await gemini.speak({ text, model: DEFAULTS.models.speech, voice: 'Kore' });
      writeFileSync(join(dir, 'in24.wav'), wav24);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(dir, 'in24.wav'), '-ar', '16000', '-ac', '1', join(dir, 'in16.wav')]);
      return readFileSync(join(dir, 'in16.wav'));
    };
    const sessions = createLiveSessions({ getKey: async () => key, model: DEFAULTS.models.live, voice: () => 'Kore' });
    const first = await sessions.turn({ sessionId: 'e2e-test-1', wav: await say('Qual é a capital da França? Responda só com o nome.') });
    assert.match(norm(first.said), /paris/);
    assert.ok(first.audio.length > 8000, 'the answer came back as sound');
    const second = await sessions.turn({ sessionId: 'e2e-test-1', wav: await say('E a da Itália?') });
    assert.match(norm(second.said), /roma/, 'it understood "a da Itália" from the first question');
    sessions.end('e2e-test-1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
