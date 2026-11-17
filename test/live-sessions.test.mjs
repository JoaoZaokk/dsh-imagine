import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveSessions } from '../lib/live-sessions.js';
import { pcmToWav, wavToPcm, wavSeconds } from '../lib/wav.js';
import { ImagineError } from '../lib/errors.js';

const speech = (seconds) => pcmToWav(Buffer.alloc(Math.round(16000 * 2 * seconds), 7), 16000);

/** A stand-in for lib/live.js: it records what it is sent and answers when the audio ends. */
function fakeOpen() {
  const opened = [];
  const open = (options) => {
    const session = { options, audio: [], ended: 0, closed: 0 };
    session.opened = Promise.resolve();
    session.sendAudio = (pcm) => session.audio.push(Buffer.from(pcm));
    session.endAudio = () => {
      session.ended += 1;
      setImmediate(() => {
        options.onText?.('Qual é a capital da França?', 'user');
        options.onAudio?.(Buffer.alloc(4800, 1));
        options.onText?.('Paris.', 'model');
        options.onAudio?.(Buffer.alloc(4800, 2));
        options.onTurnComplete?.();
      });
    };
    session.close = () => { session.closed += 1; };
    opened.push(session);
    return session;
  };
  return { open, opened };
}

const make = (extra = {}) => {
  const fake = fakeOpen();
  const sessions = createLiveSessions({ getKey: async () => 'k', model: 'm', voice: () => 'Kore', openLive: fake.open, idleMs: 60000, ...extra });
  return { fake, sessions };
};

test('wavToPcm: reads 16 kHz mono 16-bit speech out of a WAV, and refuses anything else', () => {
  const pcm = wavToPcm(speech(0.5));
  assert.equal(pcm.length, 16000);
  assert.throws(() => wavToPcm(pcmToWav(Buffer.alloc(100), 24000)), (e) => e.code === 'badRequest' && /16 kHz/.test(e.message));
  assert.throws(() => wavToPcm(pcmToWav(Buffer.alloc(100), 16000, 2)), (e) => e.code === 'badRequest');
  assert.throws(() => wavToPcm(Buffer.from('not audio at all')), (e) => e.code === 'badRequest');
});

test('a turn sends the speech, then answers with what was heard, what was said and the reply as a 24 kHz WAV', async () => {
  const { fake, sessions } = make();
  const turn = await sessions.turn({ sessionId: 'a', wav: speech(1) });
  assert.equal(turn.heard, 'Qual é a capital da França?');
  assert.equal(turn.said, 'Paris.');
  assert.equal(wavSeconds(turn.audio), 0.2, '9600 bytes at 24 kHz');
  const [session] = fake.opened;
  assert.equal(Buffer.concat(session.audio).length, 32000 + 48000, 'the speech, then 1.5 s of silence: Gemini ends the turn on silence, not on being told');
  assert.ok(session.audio.every((chunk) => chunk.length <= 32768));
  assert.equal(session.ended, 1);
});

test('the same session id keeps one Gemini session (so it remembers), another id opens another', async () => {
  const { fake, sessions } = make();
  await sessions.turn({ sessionId: 'a', wav: speech(0.2) });
  await sessions.turn({ sessionId: 'a', wav: speech(0.2) });
  assert.equal(fake.opened.length, 1);
  assert.equal(fake.opened[0].ended, 2);
  await sessions.turn({ sessionId: 'b', wav: speech(0.2) });
  assert.equal(fake.opened.length, 2);
  assert.equal(sessions.size(), 2);
});

test('each turn answers only with its own words and sound', async () => {
  const { sessions } = make();
  const first = await sessions.turn({ sessionId: 'a', wav: speech(0.2) });
  const second = await sessions.turn({ sessionId: 'a', wav: speech(0.2) });
  assert.equal(second.said, 'Paris.', 'not "Paris.Paris."');
  assert.equal(second.audio.length, first.audio.length);
});

test('ending a session closes it; a session left alone is closed after the idle time', async () => {
  const { fake, sessions } = make({ idleMs: 20 });
  await sessions.turn({ sessionId: 'a', wav: speech(0.2) });
  assert.equal(sessions.end('a'), true);
  assert.equal(fake.opened[0].closed, 1);
  assert.equal(sessions.end('a'), false, 'already gone');
  await sessions.turn({ sessionId: 'b', wav: speech(0.2) });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fake.opened[1].closed, 1, 'closed by the idle timer');
  assert.equal(sessions.size(), 0);
});

test('only a few sessions at once: the oldest makes room', async () => {
  const { fake, sessions } = make({ max: 2 });
  await sessions.turn({ sessionId: 'a', wav: speech(0.2) });
  await sessions.turn({ sessionId: 'b', wav: speech(0.2) });
  await sessions.turn({ sessionId: 'c', wav: speech(0.2) });
  assert.equal(sessions.size(), 2);
  assert.equal(fake.opened[0].closed, 1, 'a was the oldest');
});

test('no key is notConfigured; a session that dies mid-turn is an upstream error and is forgotten', async () => {
  const none = createLiveSessions({ getKey: async () => undefined, model: 'm', openLive: fakeOpen().open });
  await assert.rejects(() => none.turn({ sessionId: 'a', wav: speech(0.2) }), (e) => e instanceof ImagineError && e.code === 'notConfigured');
  const dying = createLiveSessions({
    getKey: async () => 'k', model: 'm',
    openLive: (options) => ({ opened: Promise.resolve(), sendAudio() {}, close() {}, endAudio() { setImmediate(() => options.onClose?.(1011, 'boom')); } }),
  });
  await assert.rejects(() => dying.turn({ sessionId: 'a', wav: speech(0.2) }), (e) => e.code === 'upstream');
  assert.equal(dying.size(), 0, 'a dead session is not reused');
});

test('a turn that never completes gives up after the timeout', async () => {
  const silent = createLiveSessions({
    getKey: async () => 'k', model: 'm', turnTimeoutMs: 30,
    openLive: () => ({ opened: Promise.resolve(), sendAudio() {}, endAudio() {}, close() {} }),
  });
  await assert.rejects(() => silent.turn({ sessionId: 'a', wav: speech(0.2) }), (e) => e.code === 'upstream' && /did not answer/i.test(e.message));
});
