/**
 * dsh-imagine: Gemini for the DeepSeek Harness.
 *
 * Two doors lead to the same code:
 *  - the agent gets tools (`generate_image`, `speak`);
 *  - the phone app (and any other client logged in to the dsh) gets HTTP routes under `/imagine`.
 *
 * Every route first passes the Harness `connection` fence (Host/Origin check + browser login cookie),
 * like the other dsh plugins. The API key never leaves this process: it comes from an environment
 * variable or a 0600 file, is read on each call (so it can be changed without a restart) and is never
 * logged or returned.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createGemini } from './lib/gemini.js';
import { createHandler } from './lib/handler.js';
import { createStore } from './lib/store.js';

export const name = 'dsh-imagine';
// `tools` is required: the plugin waits for the agent's tool registry, so the tools always register (an optional service may not exist yet when apply runs).
// `credentials` is optional: when the dsh has its credential store, a key saved from the phone (credentials/set) is found there first.
export const inject = { webServer: { required: true }, connection: { required: true }, tools: { required: true }, credentials: { required: false } };

const VERSION = '0.1.0';
const BASE = '/imagine';

/**
 * `defineTool` lives in the dsh's own `@deepseek-ai/dsh-tools`. A plugin installed into a profile is not
 * beside that package, so a plain import fails there. Try, in order: the plain import, the copy next to
 * the running dsh (resolved from its entry script), and an explicit path from the config.
 */
async function loadDefineTool(explicit) {
  const tried = [];
  const attempts = [
    () => import('@deepseek-ai/dsh-tools'),
    async () => {
      const entry = realpathSync(process.argv[1]);
      return import(pathToFileURL(createRequire(entry).resolve('@deepseek-ai/dsh-tools')).href);
    },
    ...(explicit ? [() => import(pathToFileURL(explicit).href)] : []),
  ];
  for (const attempt of attempts) {
    try {
      const module = await attempt();
      if (typeof module.defineTool === 'function') return { defineTool: module.defineTool };
    } catch (error) {
      tried.push(error?.code ?? error?.message ?? String(error));
    }
  }
  return { error: tried.join(', ') };
}

let loaded;
function toolsLoader(config) {
  loaded ??= loadDefineTool(config?.toolsModule);
  return loaded;
}

export const DEFAULTS = {
  apiKeyEnv: 'GEMINI_API_KEY',
  modules: { image: true, speech: true, transcribe: true, live: true },
  models: {
    image: 'gemini-3.1-flash-image',
    speech: 'gemini-3.8-flash-tts',
    transcribe: 'gemini-3.5-transcribe',
    live: 'gemini-3.8-live',
  },
  imageModels: ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image'],
  voice: 'Kore',
  dailyImageLimit: 40,
  keep: 200,
};

/** Merges the user's config over the defaults, one level deep for the nested objects. */
export function resolveSettings(config = {}) {
  return {
    version: VERSION,
    modules: { ...DEFAULTS.modules, ...(config.modules ?? {}) },
    models: { ...DEFAULTS.models, ...(config.models ?? {}) },
    imageModels: Array.isArray(config.imageModels) && config.imageModels.length ? config.imageModels : DEFAULTS.imageModels,
    voice: config.voice ?? DEFAULTS.voice,
    dailyImageLimit: Number.isFinite(config.dailyImageLimit) ? config.dailyImageLimit : DEFAULTS.dailyImageLimit,
    keep: Number.isFinite(config.keep) ? config.keep : DEFAULTS.keep,
  };
}

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/**
 * The key. In order: the dsh credential store (a key saved from the phone; it also looks at the
 * environment variable of the same name), then the environment variable, then a file. Trimmed; undefined when absent.
 * Async because the store is.
 */
export function keyReader(config = {}, env = process.env, credentials) {
  const file = String(config.apiKeyFile ?? join(dshHome(), 'gemini.key')).replace(/^~(?=\/)/, homedir());
  const refName = config.apiKeyEnv ?? DEFAULTS.apiKeyEnv;
  return async () => {
    try {
      const hit = await credentials?.resolve?.(refName);
      if (hit?.value && String(hit.value).trim()) return String(hit.value).trim();
    } catch {
      // A store that cannot answer is the same as a key that is not there; the next source decides.
    }
    const fromEnv = env[refName];
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
    try {
      const fromFile = readFileSync(file, 'utf8').trim();
      return fromFile || undefined;
    } catch {
      return undefined;
    }
  };
}

export function apply(ctx, config = {}) {
  const connection = Reflect.get(ctx, 'connection');
  const settings = resolveSettings(config);
  const getKey = keyReader(config, process.env, Reflect.get(ctx, 'credentials'));
  const store = createStore({ dir: join(dshHome(), 'imagine'), keep: settings.keep });
  const gemini = createGemini({ getKey });
  // What happened to the agent tools, for _status: the phone can say "the agent cannot draw yet".
  const agentTools = { ready: false };
  const api = createHandler({ gemini, store, settings, hasKey: async () => Boolean(await getKey()), agentTools: () => ({ ...agentTools }) });

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: BASE,
        handler: async (req, res) => {
          const rejection = connection.requestRejection(req);
          if (rejection !== undefined) {
            res.statusCode = rejection;
            res.end();
            return;
          }
          const url = new URL(String(req.url), 'http://localhost');
          const rest = url.pathname.slice(BASE.length).replace(/^\/+/, '');
          await api.handle(req, res, rest, url);
        },
      }),
    `dsh-imagine: ${BASE}`,
  );

  const tools = Reflect.get(ctx, 'tools');
  if (tools) {
    toolsLoader(config).then(({ defineTool, error }) => {
      if (defineTool) {
        registerTools(tools, defineTool, { api, store, settings });
        agentTools.ready = true;
        (ctx.logger?.info ? ctx.logger.info.bind(ctx.logger) : console.log)('[dsh-imagine] agent tools ready (generate_image, speak)');
      } else {
        agentTools.error = String(error);
        (ctx.logger?.warn ? ctx.logger.warn.bind(ctx.logger) : console.warn)(`[dsh-imagine] the agent tools are off because @deepseek-ai/dsh-tools could not be loaded (${error}). The routes still work. Set toolsModule to the path of its lib/index.js.`);
      }
    });
  }
}

/** The agent's side. Both tools only write inside the plugin's own folder. */
export function registerTools(tools, define, { api, store, settings }) {
  if (settings.modules.image) {
    tools.register(
      define({
        name: 'generate_image',
        description:
          'Generate an image from a text description with Google Gemini. The picture is saved on this computer and its path is returned. Uses paid credit: ask for one image at a time.',
        parameters: {
          prompt: { type: 'string', required: true, description: 'What the image should show: subject, style, light, composition.' },
          aspectRatio: { type: 'string', description: 'One of 1:1, 3:2, 2:3, 4:3, 3:4, 16:9, 9:16, 21:9. Default 1:1.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              images: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    path: { type: 'string', required: true },
                    mime: { type: 'string', required: true },
                    width: { type: 'number' },
                    height: { type: 'number' },
                  },
                },
              },
              note: { type: 'string' },
            },
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: `${value.images.map((image) => `Saved ${image.mime} (${image.width ?? '?'}x${image.height ?? '?'}) at ${image.path}`).join('\n')}${value.note ? `\n${value.note}` : ''}`,
            },
          ],
        },
        timeoutMs: 180000,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          const result = await api.generate({ prompt: String(args.prompt ?? '').trim(), aspectRatio: args.aspectRatio, signal: exec?.signal });
          return {
            images: result.items.map((item) => ({ id: item.id, path: store.pathOf(item), mime: item.mime, width: item.width, height: item.height })),
            ...(result.text ? { note: result.text } : {}),
          };
        },
      }),
    );
  }
  if (settings.modules.speech) {
    tools.register(
      define({
        name: 'speak',
        description: 'Turn text into speech with Google Gemini. The WAV audio is saved on this computer and its path is returned.',
        parameters: {
          text: { type: 'string', required: true, description: 'The words to say.' },
          voice: { type: 'string', description: `A Gemini voice name. Default ${settings.voice}.` },
          style: { type: 'string', description: 'How to say it, as an English adverb: "calmly", "cheerfully", "slowly". Leave empty for the default.' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true } } },
          render: (_args, value) => [{ type: 'text', text: `Saved WAV audio at ${value.path}` }],
        },
        timeoutMs: 90000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const wav = await api.speak({ text: String(args.text ?? '').trim(), voice: args.voice, style: args.style, signal: exec?.signal });
          return { path: store.addAudio(wav) };
        },
      }),
    );
  }
}
