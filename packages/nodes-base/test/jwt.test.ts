/** JWT (P2-01): sign, decode, verify on node:crypto; attacks and claim checks. */
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { credentials } from '../src';
import { decodeJwt, JWT_ALGORITHMS, signJwt, verifyJwt } from '../src/utils/jwt';
import { runNode } from './harness';

const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const SECRET = 'a-long-enough-test-secret-value';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec256 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ec384 = generateKeyPairSync('ec', { namedCurve: 'P-384' });
const ec521 = generateKeyPairSync('ec', { namedCurve: 'P-521' });
const pem = (k: { export(o: object): string | Buffer }, type: 'pkcs8' | 'spki') =>
  k.export({ type, format: 'pem' }) as string;

function keysFor(alg: string): { sign: Record<string, string>; verify: Record<string, string> } {
  if (alg.startsWith('HS')) return { sign: { secret: SECRET }, verify: { secret: SECRET } };
  const pair = alg.startsWith('ES') ? { ES256: ec256, ES384: ec384, ES512: ec521 }[alg]! : rsa;
  return {
    sign: { privateKey: pem(pair.privateKey, 'pkcs8') },
    verify: { publicKey: pem(pair.publicKey, 'spki') },
  };
}

describe('round trip per algorithm', () => {
  for (const alg of [
    'HS256',
    'HS384',
    'HS512',
    'RS256',
    'RS384',
    'RS512',
    'PS256',
    'PS384',
    'PS512',
    'ES256',
    'ES384',
    'ES512',
  ]) {
    it(alg, () => {
      const k = keysFor(alg);
      const token = signJwt({ payload: { sub: 'u1', n: 7 }, algorithm: alg, key: k.sign });
      const out = verifyJwt({ token, algorithm: alg, key: k.verify });
      expect(out.payload).toMatchObject({ sub: 'u1', n: 7 });
      expect(out.header).toMatchObject({ alg, typ: 'JWT' });
    });
  }

  it('the algorithm list has no none', () => {
    expect(JWT_ALGORITHMS).toHaveLength(12);
    expect(JWT_ALGORITHMS.map((a) => a.toLowerCase())).not.toContain('none');
  });
});

describe('tampering', () => {
  const token = signJwt({ payload: { role: 'user' }, algorithm: 'HS256', key: { secret: SECRET } });
  const [h, p, s] = token.split('.');

  it('fails when the payload is changed', () => {
    const forged = `${h}.${b64({ role: 'admin' })}.${s}`;
    expect(() => verifyJwt({ token: forged, algorithm: 'HS256', key: { secret: SECRET } })).toThrow(
      /signature/i,
    );
  });
  it('fails when one character of the signature is changed', () => {
    const flipped = s[0] === 'A' ? 'B' : 'A';
    const forged = `${h}.${p}.${flipped}${s.slice(1)}`;
    expect(() => verifyJwt({ token: forged, algorithm: 'HS256', key: { secret: SECRET } })).toThrow(
      /signature/i,
    );
  });
  it('fails with another secret', () => {
    expect(() => verifyJwt({ token, algorithm: 'HS256', key: { secret: 'another-secret-value' } })).toThrow(
      /signature/i,
    );
  });
  it('rejects alg none', () => {
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'x' })}.`;
    expect(() => verifyJwt({ token: none, algorithm: 'HS256', key: { secret: SECRET } })).toThrow();
    expect(() => verifyJwt({ token: none, algorithm: 'RS256', key: keysFor('RS256').verify })).toThrow();
  });
  it('rejects a none header that carries a signature part', () => {
    const none = `${b64({ alg: 'none' })}.${b64({ sub: 'x' })}.${s}`;
    expect(() => verifyJwt({ token: none, algorithm: 'HS256', key: { secret: SECRET } })).toThrow(
      /algorithm/i,
    );
  });
  it('rejects HS256 signed with the RSA public key under an RS256 pin', () => {
    const publicPem = keysFor('RS256').verify.publicKey;
    const head = b64({ alg: 'HS256', typ: 'JWT' });
    const body = b64({ sub: 'attacker' });
    const sig = createHmac('sha256', publicPem).update(`${head}.${body}`).digest('base64url');
    const forged = `${head}.${body}.${sig}`;
    expect(() => verifyJwt({ token: forged, algorithm: 'RS256', key: keysFor('RS256').verify })).toThrow();
  });
  it('refuses a PEM text as an HMAC secret', () => {
    const publicPem = keysFor('RS256').verify.publicKey;
    expect(() => signJwt({ payload: {}, algorithm: 'HS256', key: { secret: publicPem } })).toThrow(/PEM/);
    expect(() => verifyJwt({ token, algorithm: 'HS256', key: { secret: publicPem } })).toThrow(/PEM/);
  });
  it('rejects an HS256 token when the pinned algorithm is HS512', () => {
    expect(() => verifyJwt({ token, algorithm: 'HS512', key: { secret: SECRET } })).toThrow(/algorithm/i);
  });
  it('rejects crit headers', () => {
    const head = b64({ alg: 'HS256', crit: ['exp'] });
    const body = b64({ sub: 'x' });
    const sig = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
    expect(() =>
      verifyJwt({ token: `${head}.${body}.${sig}`, algorithm: 'HS256', key: { secret: SECRET } }),
    ).toThrow(/crit/i);
  });
  it('rejects malformed tokens', () => {
    expect(() => verifyJwt({ token: 'abc', algorithm: 'HS256', key: { secret: SECRET } })).toThrow(
      /malformed/,
    );
    expect(() => verifyJwt({ token: 'a.b.c.d', algorithm: 'HS256', key: { secret: SECRET } })).toThrow(
      /malformed/,
    );
  });
});

describe('key checks', () => {
  it('rejects an EC key under an RS algorithm and an RSA key under ES', () => {
    expect(() =>
      signJwt({ payload: {}, algorithm: 'RS256', key: { privateKey: pem(ec256.privateKey, 'pkcs8') } }),
    ).toThrow(/RSA/);
    expect(() =>
      signJwt({ payload: {}, algorithm: 'ES256', key: { privateKey: pem(rsa.privateKey, 'pkcs8') } }),
    ).toThrow(/EC/);
  });
  it('rejects the wrong curve', () => {
    expect(() =>
      signJwt({ payload: {}, algorithm: 'ES384', key: { privateKey: pem(ec256.privateKey, 'pkcs8') } }),
    ).toThrow(/P-384/);
  });
  it('rejects RSA keys under 2048 bits', () => {
    const small = generateKeyPairSync('rsa', { modulusLength: 1024 });
    expect(() =>
      signJwt({ payload: {}, algorithm: 'RS256', key: { privateKey: pem(small.privateKey, 'pkcs8') } }),
    ).toThrow(/2048/);
  });
  it('rejects the none algorithm with a clear error', () => {
    expect(() => signJwt({ payload: {}, algorithm: 'none', key: { secret: SECRET } })).toThrow(/none/);
    expect(() => verifyJwt({ token: 'a.b.c', algorithm: 'none', key: { secret: SECRET } })).toThrow(/none/);
  });
  it('accepts a PEM pasted on one line and never prints key text in errors', () => {
    const oneLine = pem(rsa.privateKey, 'pkcs8').replace(/\n/g, ' ');
    const token = signJwt({ payload: { a: 1 }, algorithm: 'RS256', key: { privateKey: oneLine } });
    expect(verifyJwt({ token, algorithm: 'RS256', key: keysFor('RS256').verify }).payload).toMatchObject({
      a: 1,
    });
    let message = '';
    try {
      signJwt({
        payload: {},
        algorithm: 'RS256',
        key: { privateKey: '-----BEGIN PRIVATE KEY-----SECRETTEXT-----END PRIVATE KEY-----' },
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('SECRETTEXT');
  });
});

describe('claims', () => {
  const key = { secret: SECRET };
  const now = 1_700_000_000_000;
  it('expired token fails, ignoreExpiration passes', () => {
    const token = signJwt({ payload: { exp: 1_700_000_000 - 10 }, algorithm: 'HS256', key });
    expect(() => verifyJwt({ token, algorithm: 'HS256', key, nowMs: now })).toThrow('jwt expired');
    const ok = verifyJwt({ token, algorithm: 'HS256', key, nowMs: now, ignoreExpiration: true });
    expect(ok.payload.exp).toBe(1_700_000_000 - 10);
  });
  it('clockTolerance extends exp and nbf', () => {
    const exp = signJwt({ payload: { exp: 1_700_000_000 - 10 }, algorithm: 'HS256', key });
    expect(verifyJwt({ token: exp, algorithm: 'HS256', key, nowMs: now, clockTolerance: 30 })).toBeTruthy();
    const nbf = signJwt({ payload: { nbf: 1_700_000_000 + 20 }, algorithm: 'HS256', key });
    expect(() => verifyJwt({ token: nbf, algorithm: 'HS256', key, nowMs: now })).toThrow('jwt not active');
    expect(verifyJwt({ token: nbf, algorithm: 'HS256', key, nowMs: now, clockTolerance: 30 })).toBeTruthy();
    expect(
      verifyJwt({ token: nbf, algorithm: 'HS256', key, nowMs: now, ignoreNotBefore: true }),
    ).toBeTruthy();
  });
  it('exp equal to now is expired', () => {
    const token = signJwt({ payload: { exp: 1_700_000_000 }, algorithm: 'HS256', key });
    expect(() => verifyJwt({ token, algorithm: 'HS256', key, nowMs: now })).toThrow('jwt expired');
  });
  it('headerClaims and kid land in the header, alg stays pinned', () => {
    const token = signJwt({
      payload: {},
      algorithm: 'HS256',
      key,
      header: { cty: 'x', alg: 'none' },
      kid: 'k1',
    });
    expect(decodeJwt(token).header).toMatchObject({ alg: 'HS256', typ: 'JWT', cty: 'x', kid: 'k1' });
  });
  it('header claims can set typ; alg stays pinned', () => {
    const token = signJwt({ payload: {}, algorithm: 'HS256', key, header: { typ: 'dpop+jwt', alg: 'none' } });
    expect(decodeJwt(token).header).toMatchObject({ alg: 'HS256', typ: 'dpop+jwt' });
  });
  it('a non-numeric exp or nbf is refused unless ignored', () => {
    for (const exp of ['1700000000', null, 'x']) {
      const token = signJwt({ payload: { exp }, algorithm: 'HS256', key });
      expect(() => verifyJwt({ token, algorithm: 'HS256', key, nowMs: now })).toThrow('invalid exp value');
      expect(verifyJwt({ token, algorithm: 'HS256', key, nowMs: now, ignoreExpiration: true })).toBeTruthy();
    }
    const nbf = signJwt({ payload: { nbf: '1' }, algorithm: 'HS256', key });
    expect(() => verifyJwt({ token: nbf, algorithm: 'HS256', key, nowMs: now })).toThrow('invalid nbf value');
    expect(
      verifyJwt({ token: nbf, algorithm: 'HS256', key, nowMs: now, ignoreNotBefore: true }),
    ).toBeTruthy();
  });
  it('decode does not check the signature', () => {
    const token = signJwt({ payload: { sub: 'z' }, algorithm: 'HS256', key });
    const d = decodeJwt(token);
    expect(d.payload).toMatchObject({ sub: 'z' });
    expect(d.signature).toBe(token.split('.')[2]);
  });
});

describe('external sample', () => {
  const sample =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  it('verifies the jwt.io HS256 token', () => {
    const out = verifyJwt({ token: sample, algorithm: 'HS256', key: { secret: 'your-256-bit-secret' } });
    expect(out.payload).toEqual({ sub: '1234567890', name: 'John Doe', iat: 1516239022 });
  });
});

describe('JWT node', () => {
  const cred = { keyType: 'passphrase', secret: SECRET, algorithm: 'HS256' };
  const run = (params: Record<string, unknown>, c: Record<string, unknown> = cred, input = [{ json: {} }]) =>
    runNode('core.jwt', params as never, input, { creds: { jwtAuth: c as never } });

  it('registers a credential without a none algorithm', () => {
    const c = credentials.find((x) => x.name === 'jwtAuth')!;
    const alg = c.properties.find((p) => p.name === 'algorithm')!;
    const values = (alg.options as Array<{ value: string }>).map((o) => o.value);
    expect(values).not.toContain('none');
    expect(values).toContain('ES512');
  });

  it('signs claims as registered claims and verifies the token', async () => {
    const signed = await run({
      operation: 'sign',
      useJson: false,
      claims: {
        audience: 'aud1',
        issuer: 'iss1',
        jwtid: 'j1',
        subject: 'sub1',
        expiresIn: 3600,
        notBefore: 0,
      },
    });
    expect(signed.status).toBe('success');
    const token = signed.outputs[0][0].token as string;
    const decoded = decodeJwt(token).payload;
    expect(decoded).toMatchObject({ aud: 'aud1', iss: 'iss1', jti: 'j1', sub: 'sub1' });
    expect(decoded.exp).toBe((decoded.iat as number) + 3600);
    expect(decoded).not.toHaveProperty('expiresIn');
    const verified = await run({ operation: 'verify', token });
    expect(verified.outputs[0][0]).toEqual({ payload: decoded });
  });

  it('claims the user did not add write nothing: no exp or nbf by default', async () => {
    for (const claims of [{}, { subject: 'only' }]) {
      const signed = await run({ operation: 'sign', useJson: false, claims });
      const decoded = decodeJwt(signed.outputs[0][0].token as string).payload;
      expect(decoded).not.toHaveProperty('exp');
      expect(decoded).not.toHaveProperty('nbf');
      expect(typeof decoded.iat).toBe('number');
    }
  });

  it('signs a JSON payload with headerClaims, kid and an algorithm override', async () => {
    const signed = await run({
      operation: 'sign',
      useJson: true,
      claimsJson: '{"hello":"world"}',
      headerClaims: '{"cty":"x"}',
      options: { kid: 'key-1', algorithm: 'HS512' },
    });
    const token = signed.outputs[0][0].token as string;
    const d = decodeJwt(token);
    expect(d.header).toMatchObject({ alg: 'HS512', kid: 'key-1', cty: 'x' });
    expect(d.payload).toMatchObject({ hello: 'world' });
    const ok = await run({ operation: 'verify', token, options: { algorithm: 'HS512', complete: true } });
    expect(ok.outputs[0][0]).toMatchObject({ header: { alg: 'HS512' }, payload: { hello: 'world' } });
    expect(ok.outputs[0][0]).toHaveProperty('signature');
  });

  it('verify fails with the reworded message on a tampered token', async () => {
    const signed = await run({ operation: 'sign', useJson: true, claimsJson: '{"a":1}' });
    const token = signed.outputs[0][0].token as string;
    const [h, , s] = token.split('.');
    const r = await run({ operation: 'verify', token: `${h}.${b64({ a: 2 })}.${s}` });
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe("The JWT token can't be verified");
  });

  it('verify reports expired tokens and honours ignoreExpiration', async () => {
    const token = signJwt({ payload: { exp: 1000 }, algorithm: 'HS256', key: { secret: SECRET } });
    const r = await run({ operation: 'verify', token });
    expect(r.error?.message).toBe('jwt expired');
    const ok = await run({ operation: 'verify', token, options: { ignoreExpiration: true } });
    expect(ok.status).toBe('success');
  });

  it('decode works with a wrong credential and returns the complete shape', async () => {
    const token = signJwt({
      payload: { sub: 'q' },
      algorithm: 'HS256',
      key: { secret: 'other-secret-xxxxxxxx' },
    });
    const r = await run({ operation: 'decode', token, options: { complete: true } });
    expect(r.outputs[0][0]).toMatchObject({ header: { alg: 'HS256' }, payload: { sub: 'q' } });
  });

  it('errors when the token is empty', async () => {
    const r = await run({ operation: 'verify', token: '' });
    expect(r.error?.message).toBe('The JWT token was not provided');
  });

  it('errors clearly on a credential set to none, with no secret in the message', async () => {
    const r = await run(
      { operation: 'sign', useJson: true, claimsJson: '{}' },
      { keyType: 'passphrase', secret: SECRET, algorithm: 'none' },
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/none/);
    expect(r.error?.message).not.toContain(SECRET);
  });

  it('signs and verifies with a PEM credential (ES256)', async () => {
    const c = {
      keyType: 'pemKey',
      privateKey: pem(ec256.privateKey, 'pkcs8'),
      publicKey: pem(ec256.publicKey, 'spki'),
      algorithm: 'ES256',
    };
    const signed = await run({ operation: 'sign', useJson: true, claimsJson: '{"x":1}' }, c);
    const token = signed.outputs[0][0].token as string;
    const ok = await run({ operation: 'verify', token }, c);
    expect(ok.outputs[0][0]).toEqual({ payload: expect.objectContaining({ x: 1 }) });
  });

  it('continues with an error item when the node is set to continue', async () => {
    const r = await runNode('core.jwt', { operation: 'verify', token: 'bad' }, [{ json: { id: 1 } }], {
      creds: { jwtAuth: cred },
      node: { onError: 'continueRegularOutput' },
    });
    expect(r.status).toBe('success');
    expect(r.outputs[0][0]).toMatchObject({ error: 'jwt malformed' });
  });
});
