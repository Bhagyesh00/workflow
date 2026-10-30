/**
 * HMAC signature checks for incoming webhooks, with presets for common providers. Every check
 * runs over the raw request body, compares in constant time and (where the provider signs a
 * timestamp) rejects stale deliveries to stop replays.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignaturePreset = 'github' | 'stripe' | 'slack' | 'shopify' | 'generic';

export interface SignatureOptions {
  preset: SignaturePreset;
  secret: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Uint8Array | undefined;
  /** seconds a signed timestamp may be old (stripe, slack) */
  toleranceSeconds?: number;
  /** generic preset */
  header?: string;
  algorithm?: 'sha1' | 'sha256' | 'sha512';
  encoding?: 'hex' | 'base64';
  prefix?: string;
  now?: number;
}

export type SignatureResult = { ok: true } | { ok: false; reason: string };

function headerOf(headers: SignatureOptions['headers'], name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function hmac(algorithm: string, secret: string, ...parts: Array<string | Uint8Array>): Buffer {
  const h = createHmac(algorithm, secret);
  for (const part of parts) h.update(part);
  return h.digest();
}

function fresh(timestamp: string | undefined, toleranceSeconds: number, now: number): boolean {
  const ts = Number(timestamp);
  return Number.isFinite(ts) && Math.abs(now / 1000 - ts) <= toleranceSeconds;
}

export function verifyWebhookSignature(options: SignatureOptions): SignatureResult {
  const { preset, secret, headers, rawBody } = options;
  if (!secret) return { ok: false, reason: 'No signing secret is configured' };
  if (!rawBody) return { ok: false, reason: 'The raw request body is not available to verify the signature' };
  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.now ?? Date.now();

  switch (preset) {
    case 'github': {
      const got = headerOf(headers, 'x-hub-signature-256') ?? '';
      const expected = `sha256=${hmac('sha256', secret, rawBody).toString('hex')}`;
      return safeEqual(got, expected) ? { ok: true } : { ok: false, reason: 'Invalid signature' };
    }
    case 'shopify': {
      const got = headerOf(headers, 'x-shopify-hmac-sha256') ?? '';
      const expected = hmac('sha256', secret, rawBody).toString('base64');
      return safeEqual(got, expected) ? { ok: true } : { ok: false, reason: 'Invalid signature' };
    }
    case 'slack': {
      const timestamp = headerOf(headers, 'x-slack-request-timestamp');
      if (!fresh(timestamp, tolerance, now))
        return { ok: false, reason: 'The request timestamp is missing or too old' };
      const got = headerOf(headers, 'x-slack-signature') ?? '';
      const expected = `v0=${hmac('sha256', secret, `v0:${timestamp}:`, rawBody).toString('hex')}`;
      return safeEqual(got, expected) ? { ok: true } : { ok: false, reason: 'Invalid signature' };
    }
    case 'stripe': {
      const header = headerOf(headers, 'stripe-signature') ?? '';
      const parts = header.split(',').map((p) => p.trim().split('='));
      const timestamp = parts.find(([k]) => k === 't')?.[1];
      if (!fresh(timestamp, tolerance, now))
        return { ok: false, reason: 'The request timestamp is missing or too old' };
      const expected = hmac('sha256', secret, `${timestamp}.`, rawBody).toString('hex');
      const valid = parts.some(([k, v]) => k === 'v1' && v !== undefined && safeEqual(v, expected));
      return valid ? { ok: true } : { ok: false, reason: 'Invalid signature' };
    }
    case 'generic': {
      const name = options.header?.trim();
      if (!name) return { ok: false, reason: 'No signature header is configured' };
      const got = headerOf(headers, name) ?? '';
      const algorithm = options.algorithm ?? 'sha256';
      const expected = `${options.prefix ?? ''}${hmac(algorithm, secret, rawBody).toString(options.encoding ?? 'hex')}`;
      return safeEqual(got, expected) ? { ok: true } : { ok: false, reason: 'Invalid signature' };
    }
    default:
      return { ok: false, reason: `Unknown signature preset "${String(preset)}"` };
  }
}
