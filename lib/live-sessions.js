import { openLive as realOpenLive } from './live.js';
import { ImagineError } from './errors.js';
import { pcmToWav, wavToPcm } from './wav.js';

const CHUNK = 32 * 1024;

/**
 * Turn-based talking with Gemini Live, for clients that cannot hold a socket open (the phone): it sends a recorded
 * utterance and gets the answer back in one response. One Gemini Live session stays open per `sessionId` between
 * turns, so the model remembers the conversation; it is closed when asked to, after a quiet spell, or to make room.
 *
 * @param {{ getKey: () => Promise<string|undefined>|string|undefined, model: string | (() => string), voice?: () => string,
 *           systemInstruction?: string, openLive?: typeof realOpenLive, idleMs?: number, max?: number, turnTimeoutMs?: number }} options
 */
export function createLiveSessions({ getKey, model, voice = () => undefined, systemInstruction, openLive = realOpenLive, idleMs = 180000, max = 3, turnTimeoutMs = 60000, trailingSilenceMs = 1500 }) {
  /** @type {Map<string, { live: any, turn: any, idle: any, dead: boolean }>} */
  const sessions = new Map();

  function drop(id) {
    const entry = sessions.get(id);
    if (!entry) return false;
    sessions.delete(id);
    clearTimeout(entry.idle);
    try { entry.live.close(); } catch { /* already closed */ }
    return true;
  }

  function touch(id, entry) {
    clearTimeout(entry.idle);
    entry.idle = setTimeout(() => drop(id), idleMs);
    entry.idle.unref?.();
  }

  async function ensure(id) {
    const existing = sessions.get(id);
    if (existing && !existing.dead) return existing;
    if (existing) drop(id);
    const key = await getKey();
    if (!key) throw new ImagineError('notConfigured', 'No Gemini API key is set on the server.');
    while (sessions.size >= max) drop(sessions.keys().next().value);
    const entry = { live: undefined, turn: undefined, idle: undefined, dead: false };
    entry.live = openLive({
      key, model: typeof model === 'function' ? model() : model, voice: voice(), systemInstruction,
      onAudio: (pcm) => entry.turn?.audio.push(pcm),
      onText: (text, who) => { if (entry.turn) entry.turn[who === 'user' ? 'heard' : 'said'] += text; },
      onTurnComplete: () => entry.turn?.done.resolve(),
      onClose: (code, reason) => {
        entry.dead = true;
        entry.turn?.done.reject(new ImagineError('upstream', `Gemini Live closed the conversation (${code}${reason ? `: ${reason}` : ''}).`));
        if (sessions.get(id) === entry) { sessions.delete(id); clearTimeout(entry.idle); }
      },
    });
    sessions.set(id, entry);
    try {
      await entry.live.opened;
    } catch (error) {
      drop(id);
      throw error;
    }
    return entry;
  }

  return {
    size: () => sessions.size,
    end: drop,
    /**
     * @param {{ sessionId: string, wav: Buffer, signal?: AbortSignal }} args
     * @returns {Promise<{ heard: string, said: string, audio: Buffer }>} `audio` is a 24 kHz mono WAV
     */
    async turn({ sessionId, wav }) {
      // Gemini decides the speaker has finished when it hears silence (an "end of stream" alone is not enough), so the
      // recording is followed by a little of it.
      const pcm = Buffer.concat([wavToPcm(wav), Buffer.alloc(Math.round((16000 * 2 * trailingSilenceMs) / 1000))]);
      const entry = await ensure(sessionId);
      if (entry.turn) throw new ImagineError('badRequest', 'This conversation is still answering the last turn.', { status: 409 });
      const done = Promise.withResolvers();
      const timer = setTimeout(() => done.reject(new ImagineError('upstream', 'Gemini Live did not answer in time.')), turnTimeoutMs);
      entry.turn = { audio: [], heard: '', said: '', done };
      clearTimeout(entry.idle);
      try {
        for (let at = 0; at < pcm.length; at += CHUNK) entry.live.sendAudio(pcm.subarray(at, at + CHUNK));
        entry.live.endAudio();
        await done.promise;
        const { audio, heard, said } = entry.turn;
        return { heard: heard.trim(), said: said.trim(), audio: pcmToWav(Buffer.concat(audio), 24000) };
      } catch (error) {
        if (!entry.dead && error instanceof ImagineError && error.code === 'upstream') drop(sessionId);
        throw error;
      } finally {
        clearTimeout(timer);
        entry.turn = undefined;
        if (sessions.get(sessionId) === entry) touch(sessionId, entry);
      }
    },
  };
}
