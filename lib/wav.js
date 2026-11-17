import { ImagineError } from './errors.js';

/** Little helpers for audio that comes back from Gemini as raw 16-bit PCM or as WAV. */

/** Wraps 16-bit little-endian mono PCM in a WAV container. */
export function pcmToWav(pcm, sampleRate = 24000, channels = 1) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * The 16-bit PCM inside a WAV that is 16 kHz, mono: what Gemini Live listens to. Anything else is a bad request that
 * says what is wanted, rather than audio Gemini would answer with noise.
 */
export function wavToPcm(wav) {
  const wrong = (why) => new ImagineError('badRequest', `Send a 16 kHz, mono, 16-bit WAV (${why}).`);
  if (!isWav(wav)) throw wrong('not a WAV file');
  let offset = 12;
  let fmt;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 24 <= wav.length) {
      fmt = { format: wav.readUInt16LE(offset + 8), channels: wav.readUInt16LE(offset + 10), rate: wav.readUInt32LE(offset + 12), bits: wav.readUInt16LE(offset + 22) };
    }
    if (id === 'data') {
      if (!fmt) throw wrong('no format chunk');
      if (fmt.format !== 1 || fmt.bits !== 16) throw wrong('not 16-bit PCM');
      if (fmt.rate !== 16000) throw wrong(`it is ${fmt.rate} Hz, not 16 kHz`);
      if (fmt.channels !== 1) throw wrong(`it has ${fmt.channels} channels, not mono`);
      return wav.subarray(offset + 8, Math.min(wav.length, offset + 8 + size));
    }
    offset += 8 + size + (size % 2);
  }
  throw wrong('no audio data');
}

/** True when the bytes start like a WAV file. */
export function isWav(bytes) {
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
}

/** Sample rate from a mime type like `audio/L16;codec=pcm;rate=24000`. */
export function rateFromMime(mime, fallback = 24000) {
  const match = /rate=(\d+)/i.exec(String(mime ?? ''));
  return match ? Number(match[1]) : fallback;
}

/** Seconds of audio in a WAV buffer, or undefined when it is not a plain PCM WAV. */
export function wavSeconds(wav) {
  if (!isWav(wav)) return undefined;
  let offset = 12;
  let byteRate;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 20 <= wav.length) byteRate = wav.readUInt32LE(offset + 16);
    if (id === 'data') return byteRate ? Math.round((Math.min(size, wav.length - offset - 8) / byteRate) * 100) / 100 : undefined;
    offset += 8 + size + (size % 2);
  }
  return undefined;
}

/** File extension for an image or audio mime type. */
export function extensionFor(mime) {
  const clean = String(mime ?? '').split(';')[0].trim().toLowerCase();
  return (
    {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/wave': 'wav',
    }[clean] ?? 'bin'
  );
}

/** PNG/JPEG/WebP pixel size from the first bytes, or undefined. */
export function imageSize(bytes) {
  try {
    if (bytes.length > 24 && bytes.toString('ascii', 1, 4) === 'PNG') {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) return undefined;
        const marker = bytes[i + 1];
        const length = bytes.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
        }
        i += 2 + length;
      }
    }
    if (bytes.length > 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
      if (bytes.toString('ascii', 12, 16) === 'VP8X') {
        return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
      }
    }
  } catch {
    // Unknown shape: the size is a nicety, not a requirement.
  }
  return undefined;
}
