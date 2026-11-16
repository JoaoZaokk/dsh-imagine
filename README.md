# dsh-imagine

**EN** · [PT](#português) · [中文](#中文)

Google **Gemini** inside the DeepSeek Harness (dsh): generate images, speak, transcribe and talk live.
One plugin, two doors: **tools for the agent** and **HTTP routes for the phone app**
([DeepSeek Harness - Mobile](https://github.com/JoaoZaokk)). The API key never leaves the dsh process.

## What it does

| Part | Model (default) | Agent tool | Route |
|---|---|---|---|
| Image | `gemini-3.1-flash-image` | `generate_image` | `POST /imagine/image`, `GET /imagine/history`, `GET /imagine/file/<id>` |
| Speech (TTS) | `gemini-3.8-flash-tts` | `speak` | `POST /imagine/speech` → `audio/wav` |
| Transcription (STT) | `gemini-3.5-transcribe` | | `POST /imagine/transcribe` (raw audio body) |
| Live voice | `gemini-3.8-live` | | helper in `lib/live.js` (relay route planned) |

Every part can be turned off in the config (`modules`); an off part has no tool and its routes answer 404.

## Install

```bash
dsh plugin --profile web add github:JoaoZaokk/dsh-imagine
```

Or from the DeepSeek Harness - Mobile app: Ajustes → Extensões → Plugins → Descobrir → "Imagine (Gemini)".

Give the dsh process a key, either way:

- environment variable `GEMINI_API_KEY` (name configurable with `apiKeyEnv`), or
- a file `<DSH_HOME>/gemini.key` with mode 0600 (path configurable with `apiKeyFile`).

The key is read on every call, so changing it needs no restart. Generated pictures and their prompts are kept in
`<DSH_HOME>/imagine/` (newest 200, configurable with `keep`).

## Config

```yaml
- insert:
    - id: dsh-imagine
      name: dsh-imagine
      config:
        apiKeyEnv: GEMINI_API_KEY
        modules: { image: true, speech: true, transcribe: true, live: true }
        dailyImageLimit: 40      # spending guard: images per calendar day
        voice: Kore
        models: { image: gemini-3.1-flash-image }
```

## Errors

Routes answer JSON `{"error":{"code","message","retryAfterSeconds?"}}`:
`quota` (429), `billing` (402, prepaid credit at zero), `badKey` (401), `blocked` (422, safety filter),
`badRequest` (400), `upstream` (502), `notConfigured` (503), `tooLarge` (413).

## Safety

- Routes pass the Harness login fence before anything else.
- The tools can only write inside the plugin's own folder; the daily image limit stops a runaway agent.
- Image ids are random hex, so no request can reach a file outside the folder.
- Errors are redacted: nothing key-shaped goes into a response or a log.

## Tests

```bash
npm test                                   # 44 tests, no network
GEMINI_API_KEY=... node --test test/live.e2e.test.mjs   # real calls, a few cents
```

---

## Português

Google **Gemini** dentro do DeepSeek Harness (dsh): gerar imagens, falar, transcrever e conversar ao vivo.
Um plugin, duas portas: **ferramentas para o agente** e **rotas HTTP para o app do celular**. A chave da API nunca sai do processo do dsh.

- **Imagem**: ferramenta `generate_image`, rotas `/imagine/image`, `/imagine/history`, `/imagine/file/<id>`.
- **Voz (TTS)**: ferramenta `speak`, rota `/imagine/speech` (devolve WAV). O jeito de falar é um advérbio em inglês (`calmly`, `cheerfully`, `slowly`).
- **Transcrição (STT)**: rota `/imagine/transcribe` (áudio no corpo, de preferência WAV 16 kHz).
- **Live (voz ao vivo)**: `lib/live.js`; a rota de retransmissão vem na próxima versão.

A chave vai na variável `GEMINI_API_KEY` do dsh ou no arquivo `<DSH_HOME>/gemini.key` (modo 0600). Dá para trocar sem reiniciar.
`dailyImageLimit` limita as imagens por dia para um agente descontrolado não gastar o crédito.

## 中文

在 DeepSeek Harness (dsh) 中使用 Google **Gemini**：生成图片、语音合成、语音转文字、实时语音。
一个插件，两个入口：**智能体工具**和**手机 App 的 HTTP 接口**。API 密钥不会离开 dsh 进程。
密钥通过环境变量 `GEMINI_API_KEY` 或文件 `<DSH_HOME>/gemini.key`（权限 0600）提供。
