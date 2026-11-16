#!/usr/bin/env node
// Opens a Gemini Live session, asks for one short sentence and prints what came back.
//   GEMINI_API_KEY=... node scripts/live-smoke.mjs [model]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { openLive } from '../lib/live.js';
import { pcmToWav } from '../lib/wav.js';

const key = process.env.GEMINI_API_KEY || readFileSync(`${homedir()}/.dsh/gemini.key`, 'utf8').trim();
const model = process.argv[2] ?? 'gemini-3.8-live';
const chunks = [];
let transcript = '';
const finished = Promise.withResolvers();
const live = openLive({
  key,
  model,
  onAudio: (pcm) => chunks.push(pcm),
  onText: (text, who) => { if (who === 'model') transcript += text; },
  onTurnComplete: () => finished.resolve(),
  onClose: () => finished.resolve(),
});
await live.opened;
live.sendText('Diga em uma frase curta, em português: o agente está pronto.');
setTimeout(() => finished.resolve(), 45000);
await finished.promise;
live.close();
const pcm = Buffer.concat(chunks);
console.log(JSON.stringify({ model, audioSeconds: +(pcm.length / 2 / 24000).toFixed(2), transcript }));
if (process.env.OUT) (await import('node:fs')).writeFileSync(process.env.OUT, pcmToWav(pcm, 24000));
