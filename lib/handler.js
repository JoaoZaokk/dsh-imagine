import { ImagineError } from './errors.js';
import { VOICES } from './gemini.js';
import { extensionFor, imageSize, wavSeconds } from './wav.js';

const MAX_JSON = 64 * 1024;
const MAX_AUDIO = 25 * 1024 * 1024;
const MIME_OK = /^audio\/(wav|x-wav|wave|mp3|mpeg|aac|mp4|x-m4a|m4a|ogg|flac|aiff|x-aiff)$/;
const ASPECTS = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);

/**
 * The HTTP side of the plugin, with no dependency on dsh: `handle(req, res, rest)` where `rest`
 * is the path after `/imagine/`. The caller has already checked the login.
 */
export function createHandler({ gemini, store, settings, now = () => Date.now(), hasKey, agentTools = () => ({ ready: false }) }) {
  const send = (res, status, body, headers = {}) => {
    res.statusCode = status;
    for (const [name, value] of Object.entries({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })) {
      res.setHeader(name, value);
    }
    res.end(body);
  };
  const sendJson = (res, status, value) => send(res, status, JSON.stringify(value), { 'content-type': 'application/json' });
  const fail = (res, error) => {
    if (error instanceof ImagineError) return sendJson(res, error.status, error.toJSON());
    return sendJson(res, 500, { error: { code: 'upstream', message: String(error?.message ?? error).slice(0, 200) } });
  };

  async function readBody(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new ImagineError('tooLarge', 'The request body is too large.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function readJson(req) {
    const raw = await readBody(req, MAX_JSON);
    if (raw.length === 0) return {};
    try {
      const value = JSON.parse(raw.toString('utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      return value;
    } catch {
      throw new ImagineError('badRequest', 'The body is not a JSON object.');
    }
  }

  const need = (module) => {
    if (!settings.modules[module]) throw new ImagineError('notFound', `The ${module} module is turned off.`, { status: 404 });
  };
  const text = (value, name, max) => {
    if (typeof value !== 'string' || value.trim() === '') throw new ImagineError('badRequest', `"${name}" is required.`);
    if (value.length > max) throw new ImagineError('badRequest', `"${name}" is too long (limit ${max} characters).`);
    return value.trim();
  };

  /** One calendar day of images, so a runaway agent cannot spend the credit. */
  function assertDailyRoom(count) {
    const start = new Date(now());
    start.setHours(0, 0, 0, 0);
    const used = store.countSince(start.getTime());
    if (used + count > settings.dailyImageLimit) {
      throw new ImagineError('quota', `The daily limit of ${settings.dailyImageLimit} images was reached (set by dailyImageLimit).`, { status: 429 });
    }
  }

  /** Makes `count` images and stores them. Shared with the agent tool. */
  async function generate({ prompt, model, aspectRatio, count = 1, signal }) {
    need('image');
    prompt = text(prompt, 'prompt', 4000);
    const chosen = model ?? settings.models.image;
    if (!settings.imageModels.includes(chosen)) throw new ImagineError('badRequest', `Unknown image model "${chosen}".`);
    if (aspectRatio !== undefined && !ASPECTS.has(aspectRatio)) throw new ImagineError('badRequest', `Unknown aspect ratio "${aspectRatio}".`);
    const wanted = Math.max(1, Math.min(Number(count) || 1, 4));
    assertDailyRoom(wanted);
    const items = [];
    let lastText = '';
    while (items.length < wanted) {
      const { images, text: said } = await gemini.generateImage({ prompt, model: chosen, aspectRatio, signal });
      lastText = said;
      for (const image of images) {
        if (items.length >= wanted) break;
        items.push(store.add({ bytes: image.bytes, mime: image.mime, prompt, model: chosen, ...(imageSize(image.bytes) ?? {}) }));
      }
    }
    return { items, text: lastText };
  }

  async function speak({ text: said, voice, model, style, signal }) {
    need('speech');
    said = text(said, 'text', 5000);
    const chosenVoice = voice ?? settings.voice;
    if (!VOICES.includes(chosenVoice)) throw new ImagineError('badRequest', `Unknown voice "${chosenVoice}".`);
    return gemini.speak({ text: said, model: model ?? settings.models.speech, voice: chosenVoice, style, signal });
  }

  async function handle(req, res, rest, url) {
    try {
      const method = req.method ?? 'GET';
      const route = (verb, pattern) => method === verb && pattern.test(rest);

      if (rest === '_status') {
        if (method !== 'GET') throw new ImagineError('badRequest', 'Use GET.', { status: 405 });
        return sendJson(res, 200, {
          configured: Boolean(await hasKey()),
          version: settings.version,
          modules: settings.modules,
          models: settings.models,
          imageModels: settings.imageModels,
          voices: VOICES,
          voice: settings.voice,
          dailyImageLimit: settings.dailyImageLimit,
          agentTools: agentTools(),
        });
      }

      if (route('POST', /^image$/)) {
        const body = await readJson(req);
        const result = await generate({
          prompt: text(body.prompt, 'prompt', 4000),
          model: typeof body.model === 'string' ? body.model : undefined,
          aspectRatio: typeof body.aspectRatio === 'string' ? body.aspectRatio : undefined,
          count: body.count,
        });
        return sendJson(res, 200, { items: result.items, ...(result.text ? { text: result.text } : {}) });
      }

      if (route('GET', /^history$/)) {
        need('image');
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const page = store.list({ limit: Number.isFinite(limit) ? limit : 50, offset: Number.isFinite(offset) ? Math.max(0, offset) : 0 });
        return sendJson(res, 200, { items: page.items, hasMore: page.hasMore });
      }

      let match = /^file\/([^/]+)$/.exec(rest);
      if (method === 'GET' && match) {
        need('image');
        const found = store.get(match[1]);
        if (!found) throw new ImagineError('notFound', 'No such image.', { status: 404 });
        return send(res, 200, found.bytes, { 'content-type': found.item.mime, 'cache-control': 'private, max-age=86400' });
      }

      match = /^history\/([^/]+)$/.exec(rest);
      if (method === 'DELETE' && match) {
        need('image');
        if (!store.remove(match[1])) throw new ImagineError('notFound', 'No such image.', { status: 404 });
        return sendJson(res, 200, { ok: true });
      }

      if (route('POST', /^check$/)) {
        const body = await readJson(req);
        if (body.key !== undefined && typeof body.key !== 'string') throw new ImagineError('badRequest', '"key" must be text.');
        await gemini.check({ key: typeof body.key === 'string' ? body.key.trim() || undefined : undefined });
        return sendJson(res, 200, { ok: true });
      }

      if (route('POST', /^speech$/)) {
        const body = await readJson(req);
        const wav = await speak({
          text: text(body.text, 'text', 5000),
          voice: typeof body.voice === 'string' ? body.voice : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
          style: typeof body.style === 'string' && body.style.trim() ? body.style.trim().slice(0, 200) : undefined,
        });
        return send(res, 200, wav, { 'content-type': 'audio/wav' });
      }

      if (route('POST', /^transcribe$/)) {
        need('transcribe');
        const mimeType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (!MIME_OK.test(mimeType)) throw new ImagineError('badRequest', `Send the audio with a Content-Type like audio/wav (got "${mimeType || 'none'}").`);
        const audio = await readBody(req, MAX_AUDIO);
        if (audio.length === 0) throw new ImagineError('badRequest', 'The audio is empty.');
        const language = url.searchParams.get('language') ?? undefined;
        const said = await gemini.transcribe({
          audio,
          mimeType: mimeType === 'audio/x-m4a' || mimeType === 'audio/m4a' ? 'audio/mp4' : mimeType,
          model: settings.models.transcribe,
          language: language && /^[A-Za-z-]{2,10}$/.test(language) ? language : undefined,
        });
        const seconds = wavSeconds(audio);
        return sendJson(res, 200, { text: said, model: settings.models.transcribe, ...(seconds !== undefined ? { seconds } : {}) });
      }

      return sendJson(res, 404, { error: { code: 'notFound', message: `No such route: ${method} /imagine/${rest}` } });
    } catch (error) {
      if (!res.headersSent) fail(res, error);
      else res.end();
    }
  }

  return { handle, generate, speak, extensionFor };
}
