import { ImagineError, fromGoogle, redact } from './errors.js';
import { pcmToWav, isWav, rateFromMime } from './wav.js';

export const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** The Gemini voices that every TTS model accepts. */
export const VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia',
  'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix',
  'Sadachbia', 'Sadaltager', 'Sulafat',
];

/**
 * A small Gemini client: just the four things this plugin needs. `fetch` and `getKey` are
 * injected so tests never touch the network and the key is never stored on the client.
 *
 * @param {{ getKey: () => string | undefined | Promise<string | undefined>, fetch?: typeof fetch, base?: string }} options
 */
export function createGemini({ getKey, fetch: fetchImpl = globalThis.fetch, base = BASE }) {
  async function post(model, body, { timeoutMs = 120000, signal } = {}) {
    const key = await getKey();
    if (!key) throw new ImagineError('notConfigured', 'No Gemini API key is set on the server.');
    let response;
    try {
      response = await fetchImpl(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ImagineError('upstream', redact(`Could not reach Gemini: ${error?.cause?.code ?? error?.message ?? error}`));
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ImagineError('upstream', `Gemini answered with something that is not JSON (HTTP ${response.status}).`);
    }
    if (!response.ok) throw fromGoogle(response.status, data);
    return data;
  }

  /** Why Google returned nothing usable: a safety block, or just no media. */
  function emptyReason(data, what) {
    const block = data?.promptFeedback?.blockReason;
    const finish = data?.candidates?.[0]?.finishReason;
    if (block) return new ImagineError('blocked', `Gemini blocked the request (${block}).`);
    if (finish && !['STOP', 'MAX_TOKENS'].includes(finish)) {
      return new ImagineError('blocked', `Gemini did not return ${what} (${finish}).`);
    }
    return new ImagineError('upstream', `Gemini returned no ${what}.`);
  }

  return {
    /**
     * Asks Google whether the key works, with the cheapest call there is (list one model). Throws the same
     * errors as the other calls (badKey, billing, quota, upstream); resolves with nothing when the key is good.
     * @param {{ signal?: AbortSignal }} [options]
     */
    async check({ signal } = {}) {
      const key = await getKey();
      if (!key) throw new ImagineError('notConfigured', 'No Gemini API key is set on the server.');
      let response;
      try {
        response = await fetchImpl(`${base}/models?pageSize=1`, {
          method: 'GET',
          headers: { 'x-goog-api-key': key },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
        });
      } catch (error) {
        throw new ImagineError('upstream', redact(`Could not reach Gemini: ${error?.cause?.code ?? error?.message ?? error}`));
      }
      if (response.ok) return;
      let data;
      try { data = await response.json(); } catch { data = undefined; }
      throw fromGoogle(response.status, data);
    },

    /**
     * One request that may yield several images. Returns `{ images: [{ mime, bytes }], text }`.
     * @param {{ prompt: string, model: string, aspectRatio?: string, imageSize?: string, signal?: AbortSignal }} args
     */
    async generateImage({ prompt, model, aspectRatio, imageSize, signal }) {
      const imageConfig = {};
      if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
      if (imageSize) imageConfig.imageSize = imageSize;
      const data = await post(
        model,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
          },
        },
        { signal },
      );
      const parts = data.candidates?.flatMap((c) => c.content?.parts ?? []) ?? [];
      const images = parts
        .filter((p) => p.inlineData?.data && String(p.inlineData.mimeType).startsWith('image/'))
        .map((p) => ({ mime: p.inlineData.mimeType, bytes: Buffer.from(p.inlineData.data, 'base64') }));
      if (images.length === 0) throw emptyReason(data, 'an image');
      return { images, text: parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim() };
    },

    /**
     * Text to speech. Returns a WAV buffer: Gemini sends WAV or raw 16-bit PCM depending on the model.
     * @param {{ text: string, model: string, voice?: string, style?: string, signal?: AbortSignal }} args
     */
    async speak({ text, model, voice = 'Kore', style, signal }) {
      // "Say calmly: ..." is understood as direction and not read aloud; other shapes sometimes are.
      const spoken = style ? `Say ${style}: ${text}` : text;
      const data = await post(
        model,
        {
          contents: [{ parts: [{ text: spoken }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          },
        },
        { timeoutMs: 60000, signal },
      );
      const part = data.candidates?.flatMap((c) => c.content?.parts ?? []).find((p) => p.inlineData?.data);
      if (!part) throw emptyReason(data, 'audio');
      const bytes = Buffer.from(part.inlineData.data, 'base64');
      return isWav(bytes) ? bytes : pcmToWav(bytes, rateFromMime(part.inlineData.mimeType));
    },

    /**
     * Speech to text. The new transcription models answer with an `audioTranscription` part;
     * ordinary Gemini models answer with text. Both are understood.
     * @param {{ audio: Buffer, mimeType: string, model: string, language?: string, signal?: AbortSignal }} args
     */
    async transcribe({ audio, mimeType, model, language, signal }) {
      const ask = language
        ? `Transcribe this audio. The language is ${language}. Answer with the transcript only.`
        : 'Transcribe this audio in its original language. Answer with the transcript only.';
      const data = await post(
        model,
        { contents: [{ parts: [{ text: ask }, { inlineData: { mimeType, data: audio.toString('base64') } }] }] },
        { timeoutMs: 90000, signal },
      );
      const parts = data.candidates?.flatMap((c) => c.content?.parts ?? []) ?? [];
      const text = parts
        .map((p) => p.audioTranscription?.text ?? (p.thought ? '' : p.text) ?? '')
        .join('')
        .trim();
      if (!text) {
        if (data.candidates?.[0]?.finishReason === 'STOP') return '';
        throw emptyReason(data, 'a transcript');
      }
      return text;
    },
  };
}
