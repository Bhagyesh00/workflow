/** TOTP (RFC 6238) on node:crypto: base32 decoding and the one-time code. Pure, no node context. */
import { createHmac } from 'node:crypto';

export const TOTP_ALGORITHMS = [
  'sha1',
  'sha224',
  'sha256',
  'sha384',
  'sha512',
  'sha3-224',
  'sha3-256',
  'sha3-384',
  'sha3-512',
] as const;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Decode a base32 secret. Case, spaces, hyphens and `=` padding are ignored. Never echoes the input. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error('The secret is not valid base32 (use the letters A-Z and the digits 2-7)');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
      value &= (1 << bits) - 1;
    }
  }
  if (out.length === 0) throw new Error('The secret is empty');
  return Buffer.from(out);
}

export interface TotpInput {
  /** base32 text */
  secret: string;
  /** one of TOTP_ALGORITHMS, any case; sha1 when empty */
  algorithm?: string;
  digits?: number;
  period?: number;
  timestampMs: number;
}

/** RFC 4226 truncation over the RFC 6238 time counter. */
export function totp(input: TotpInput): { token: string; secondsRemaining: number } {
  const algorithm = (input.algorithm || 'sha1').toLowerCase();
  if (!(TOTP_ALGORITHMS as readonly string[]).includes(algorithm)) {
    throw new Error(`Unknown algorithm "${algorithm}"`);
  }
  const digits = Math.min(10, Math.max(1, Math.floor(Number(input.digits) || 6)));
  const period = Math.max(1, Math.floor(Number(input.period) || 30));
  const seconds = Math.floor(input.timestampMs / 1000);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / period)));
  const hmac = createHmac(algorithm, base32Decode(input.secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  const token = String(binary % 10 ** digits).padStart(digits, '0');
  return { token, secondsRemaining: period - (seconds % period) };
}
