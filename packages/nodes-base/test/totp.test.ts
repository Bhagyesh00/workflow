/** TOTP (P2-02): RFC 6238 Appendix B vectors against the pure function, and the node with a fake clock. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { base32Decode, totp } from '../src/utils/totp';
import { runNode } from './harness';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(text: string): string {
  let bits = '';
  for (const b of Buffer.from(text, 'ascii')) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5)
    out += ALPHABET[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

// RFC 6238 Appendix B: seeds are ASCII, repeated to the hash's key size; 8 digits, period 30
const SEEDS = {
  sha1: '12345678901234567890',
  sha256: '12345678901234567890123456789012',
  sha512: '1234567890123456789012345678901234567890123456789012345678901234',
};
const VECTORS: Array<[number, Record<'sha1' | 'sha256' | 'sha512', string>]> = [
  [59, { sha1: '94287082', sha256: '46119246', sha512: '90693936' }],
  [1111111109, { sha1: '07081804', sha256: '68084774', sha512: '25091201' }],
  [1111111111, { sha1: '14050471', sha256: '67062674', sha512: '99943326' }],
  [1234567890, { sha1: '89005924', sha256: '91819424', sha512: '93441116' }],
  [2000000000, { sha1: '69279037', sha256: '90698825', sha512: '38618901' }],
  [20000000000, { sha1: '65353130', sha256: '77737706', sha512: '47863826' }],
];

describe('totp() RFC 6238 vectors', () => {
  it('uses the 64-byte sha512 seed', () => {
    expect(SEEDS.sha512.length).toBe(64);
    expect(SEEDS.sha256.length).toBe(32);
  });
  for (const [t, expected] of VECTORS) {
    for (const algorithm of ['sha1', 'sha256', 'sha512'] as const) {
      it(`T=${t} ${algorithm}`, () => {
        const r = totp({
          secret: base32Encode(SEEDS[algorithm]),
          algorithm,
          digits: 8,
          period: 30,
          timestampMs: t * 1000,
        });
        expect(r.token).toBe(expected[algorithm]);
      });
    }
  }

  it('computes seconds remaining', () => {
    const base = { secret: base32Encode(SEEDS.sha1), algorithm: 'sha1', digits: 6, period: 30 };
    expect(totp({ ...base, timestampMs: 59_000 }).secondsRemaining).toBe(1);
    expect(totp({ ...base, timestampMs: 60_000 }).secondsRemaining).toBe(30);
    expect(totp({ ...base, timestampMs: 60_999 }).secondsRemaining).toBe(30);
  });

  it('truncates to fewer digits and pads with zeros', () => {
    const base = { secret: base32Encode(SEEDS.sha1), algorithm: 'sha1', period: 30 };
    expect(totp({ ...base, digits: 6, timestampMs: 59_000 }).token).toBe('287082');
    expect(totp({ ...base, digits: 8, timestampMs: 1111111109_000 }).token).toBe('07081804');
  });

  it('supports every listed algorithm', () => {
    for (const algorithm of [
      'sha1',
      'sha224',
      'sha256',
      'sha384',
      'sha512',
      'sha3-224',
      'sha3-256',
      'sha3-384',
      'sha3-512',
    ]) {
      const r = totp({ secret: 'GEZDGNBVGY3TQOJQ', algorithm, digits: 6, period: 30, timestampMs: 0 });
      expect(r.token).toMatch(/^\d{6}$/);
    }
  });
});

describe('base32Decode', () => {
  it('tolerates case, spaces, hyphens and padding', () => {
    const plain = base32Decode('GEZDGNBVGY3TQOJQ');
    expect(Buffer.from(plain).toString('ascii')).toBe('1234567890');
    expect(base32Decode('gezd gnbv-gy3t qojq====')).toEqual(plain);
  });
  it('rejects bad characters without echoing the secret', () => {
    let message = '';
    try {
      base32Decode('GEZD1SECRETZ!');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/base32/i);
    expect(message).not.toContain('SECRET');
    expect(message).not.toContain('GEZD');
  });
});

describe('TOTP node', () => {
  afterEach(() => vi.useRealTimers());
  const secret = base32Encode(SEEDS.sha1);

  it('returns token and secondsRemaining with defaults at T=59', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(59_000);
    const r = await runNode(
      'core.totp',
      { operation: 'generateSecret' },
      [{ json: { a: 1 } }, { json: { a: 2 } }],
      {
        creds: { totpApi: { secret } },
      },
    );
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([
      { token: '287082', secondsRemaining: 1 },
      { token: '287082', secondsRemaining: 1 },
    ]);
  });

  it('honours algorithm, digits and period options', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(59_000);
    const r = await runNode(
      'core.totp',
      { operation: 'generateSecret', options: { algorithm: 'SHA256', digits: 8, period: 30 } },
      [{ json: {} }],
      { creds: { totpApi: { secret: base32Encode(SEEDS.sha256) } } },
    );
    expect(r.outputs[0][0]).toEqual({ token: '46119246', secondsRemaining: 1 });
  });

  it('accepts a lowercase spaced secret and a good label', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(59_000);
    const spaced = secret.toLowerCase().replace(/(.{4})/g, '$1 ');
    const r = await runNode('core.totp', { operation: 'generateSecret' }, [{ json: {} }], {
      creds: { totpApi: { secret: spaced, label: 'GitHub:john-doe' } },
    });
    expect(r.outputs[0][0]).toMatchObject({ token: '287082' });
  });

  it('throws on a malformed label', async () => {
    const r = await runNode('core.totp', { operation: 'generateSecret' }, [{ json: {} }], {
      creds: { totpApi: { secret, label: 'nocolon' } },
    });
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/Malformed label/);
  });

  it('throws on a bad secret without echoing it', async () => {
    const r = await runNode('core.totp', { operation: 'generateSecret' }, [{ json: {} }], {
      creds: { totpApi: { secret: 'NOT-VALID-1989!!' } },
    });
    expect(r.status).toBe('error');
    expect(r.error?.message).not.toContain('NOT-VALID');
  });
});
