import { ImagineError, redact } from './errors.js';

export const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/**
 * Opens a Gemini Live session and returns a small object to talk through it. Audio in is 16-bit PCM at
 * 16 kHz; audio out is 16-bit PCM at 24 kHz. The key goes in the URL, so nothing here may log the URL.
 *
 * @param {{ key: string, model: string, voice?: string, systemInstruction?: string, WebSocketImpl?: typeof WebSocket,
 *           onAudio?: (pcm: Buffer) => void, onText?: (text: string, who: 'model' | 'user') => void,
 *           onTurnComplete?: () => void, onClose?: (code: number, reason: string) => void }} options
 */
export function openLive({ key, model, voice, systemInstruction, WebSocketImpl = globalThis.WebSocket, onAudio, onText, onTurnComplete, onClose }) {
  if (!key) throw new ImagineError('notConfigured', 'No Gemini API key is set on the server.');
  const ws = new WebSocketImpl(`${LIVE_URL}?key=${encodeURIComponent(key)}`);
  let ready;
  let failed;
  const opened = new Promise((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });

  ws.onopen = () => {
    const setup = {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        ...(voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } : {}),
      },
      outputAudioTranscription: {},
      inputAudioTranscription: {},
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
    };
    ws.send(JSON.stringify({ setup }));
  };
  ws.onmessage = async (event) => {
    let message;
    try {
      const raw = typeof event.data === 'string' ? event.data : Buffer.from(await event.data.arrayBuffer()).toString();
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.setupComplete) ready();
    const content = message.serverContent;
    if (!content) return;
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) onAudio?.(Buffer.from(part.inlineData.data, 'base64'));
    }
    if (content.outputTranscription?.text) onText?.(content.outputTranscription.text, 'model');
    if (content.inputTranscription?.text) onText?.(content.inputTranscription.text, 'user');
    if (content.turnComplete) onTurnComplete?.();
  };
  ws.onerror = (event) => failed(new ImagineError('upstream', redact(`Live connection failed: ${event?.message ?? event?.type ?? 'error'}`)));
  ws.onclose = (event) => {
    failed(new ImagineError('upstream', `Live connection closed (${event.code}).`));
    onClose?.(event.code, redact(event.reason ?? ''));
  };

  return {
    opened,
    sendText(text) {
      ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }));
    },
    /** 16-bit PCM, 16 kHz, mono. */
    sendAudio(pcm) {
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: Buffer.from(pcm).toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
    },
    endAudio() {
      ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    },
    close() {
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
}
