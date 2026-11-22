import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Checks on an incoming wake call. Moyik signs wakes for signed-webhook seats the way the
 * Standard Webhooks convention describes (https://www.standardwebhooks.com/), and sends a
 * bearer secret you chose for plain-webhook seats. Use whichever matches how you set the seat up.
 */

/** How far a signed call's timestamp may be from your clock, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

export type VerifyFailure = 'missing_headers' | 'bad_secret' | 'stale_timestamp' | 'bad_signature' | 'bad_token';

/** Header lookup that works for Node's IncomingHttpHeaders, a Fetch Headers object or a plain object. */
export type HeaderSource = Headers | Record<string, string | string[] | undefined>;

export function header(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? undefined : record[key];
  return Array.isArray(value) ? value[0] : value;
}

/** The raw key bytes of a `whsec_…` signing secret, or null when it is not one. */
export function signingKey(secret: string): Buffer | null {
  const value = secret.trim();
  if (!/^whsec_[A-Za-z0-9+/=_-]+$/.test(value)) return null;
  const key = Buffer.from(value.slice('whsec_'.length), 'base64');
  return key.length >= 16 ? key : null;
}

/** The `v1,<base64>` signature for one call. Exposed so you can write your own tests. */
export function sign(secret: string, id: string, timestamp: string, body: string): string {
  const key = signingKey(secret);
  if (!key) throw new Error('not a whsec_ signing secret');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Verifies a signed wake. `body` must be the raw request body exactly as received: parse JSON
 * only after this passes.
 */
export function verifySigned(
  secret: string,
  headers: HeaderSource,
  body: string,
  opts: { toleranceSeconds?: number; now?: number } = {},
): VerifyResult {
  const id = header(headers, 'webhook-id');
  const timestamp = header(headers, 'webhook-timestamp');
  const signatures = header(headers, 'webhook-signature');
  if (!id || !timestamp || !signatures) return { ok: false, reason: 'missing_headers' };
  if (!signingKey(secret)) return { ok: false, reason: 'bad_secret' };

  const seconds = Number(timestamp);
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!/^\d+$/.test(timestamp) || Math.abs(now - seconds) > tolerance) return { ok: false, reason: 'stale_timestamp' };

  const expected = sign(secret, id, timestamp, body);
  // The header may carry several space-separated signatures (for example during a secret rotation).
  const match = signatures.split(' ').some((candidate) => candidate.startsWith('v1,') && sameText(candidate, expected));
  return match ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

/** Verifies a plain webhook that carries `Authorization: Bearer <your secret>`. */
export function verifyBearer(secret: string, headers: HeaderSource): VerifyResult {
  const value = header(headers, 'authorization');
  if (!value) return { ok: false, reason: 'missing_headers' };
  const token = /^Bearer\s+(\S+)$/i.exec(value.trim())?.[1];
  if (!token || !secret) return { ok: false, reason: 'bad_token' };
  return sameText(token, secret.trim()) ? { ok: true } : { ok: false, reason: 'bad_token' };
}
