/**
 * One error type for everything that can go wrong between the phone, this plugin and Google.
 * `code` is the contract the phone app reads (see README "Errors"); `status` is the HTTP status
 * the route answers with.
 */
export class ImagineError extends Error {
  constructor(code, message, { status, retryAfterSeconds } = {}) {
    super(message);
    this.name = 'ImagineError';
    this.code = code;
    this.status = status ?? STATUS[code] ?? 500;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.retryAfterSeconds !== undefined ? { retryAfterSeconds: this.retryAfterSeconds } : {}),
      },
    };
  }
}

const STATUS = { billing: 402, quota: 429, badKey: 401, blocked: 422, badRequest: 400, upstream: 502, notConfigured: 503, tooLarge: 413 };

/** "Please retry in 4h36m54.1s" or "retry in 16s" from a Google message, as seconds. */
export function retrySeconds(text) {
  const match = /retry in\s+((?:\d+(?:\.\d+)?[hms])+)/i.exec(String(text ?? ''));
  if (!match) return undefined;
  let total = 0;
  for (const [, n, unit] of match[1].matchAll(/(\d+(?:\.\d+)?)([hms])/g)) {
    total += Number(n) * { h: 3600, m: 60, s: 1 }[unit];
  }
  return Math.ceil(total);
}

/** Turns a Google API error response into an ImagineError. Never includes the API key. */
export function fromGoogle(status, body) {
  const error = body && typeof body === 'object' ? body.error : undefined;
  const message = redact(String(error?.message ?? `HTTP ${status}`));
  const retryDelay = error?.details?.find?.((d) => typeof d?.retryDelay === 'string')?.retryDelay;
  const retryAfterSeconds = retrySeconds(message) ?? (retryDelay ? retrySeconds(`retry in ${retryDelay}`) : undefined);
  // Prepaid credit at zero is an account matter, not a rate limit: waiting will not fix it.
  if (status === 402 || /prepayment credits (are )?depleted/i.test(message)) {
    return new ImagineError('billing', short(message), { status: 402 });
  }
  if (status === 429 || error?.status === 'RESOURCE_EXHAUSTED') {
    return new ImagineError('quota', short(message), { retryAfterSeconds });
  }
  if (status === 401 || status === 403 || /api key not valid|API_KEY_INVALID|permission/i.test(message)) {
    return new ImagineError('badKey', short(message));
  }
  if (status === 400) return new ImagineError('badRequest', short(message));
  return new ImagineError('upstream', short(message), { status: 502 });
}

/** Removes anything key-shaped from text before it goes into a log or a response. */
export function redact(text) {
  return String(text).replace(/(key=)[^&\s"']+/gi, '$1<hidden>').replace(/AIza[0-9A-Za-z_-]{20,}/g, '<hidden>');
}

function short(text) {
  const one = text.split('\n')[0];
  return one.length > 240 ? `${one.slice(0, 237)}...` : one;
}
