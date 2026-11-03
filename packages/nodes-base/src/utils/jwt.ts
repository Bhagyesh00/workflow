/**
 * JSON Web Tokens on node:crypto: HS, RS, PS and ES algorithms only.
 *
 * The algorithm always comes from the caller (option or credential), never from the token. The key family
 * must fit it, so an RSA public key can never act as an HMAC secret. Errors never contain key text.
 */
import {
  constants,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
  timingSafeEqual,
} from 'node:crypto';
import { formatPemBlock } from './pem';

export const JWT_ALGORITHMS = [
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
] as const;
export type JwtAlgorithm = (typeof JWT_ALGORITHMS)[number];

export type JwtErrorKind = 'config' | 'malformed' | 'algorithm' | 'signature' | 'claims';

export class JwtError extends Error {
  constructor(
    readonly kind: JwtErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'JwtError';
  }
}

export interface JwtKey {
  /** HS algorithms */
  secret?: string;
  /** RS, PS, ES: signing */
  privateKey?: string;
  /** RS, PS, ES: verifying */
  publicKey?: string;
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: string;
}

const CURVES: Record<string, string> = { ES256: 'prime256v1', ES384: 'secp384r1', ES512: 'secp521r1' };
const CURVE_NAMES: Record<string, string> = { ES256: 'P-256', ES384: 'P-384', ES512: 'P-521' };
const BASE64URL = /^[A-Za-z0-9_-]*$/;

function checkAlgorithm(algorithm: string): JwtAlgorithm {
  if (algorithm.toLowerCase() === 'none') {
    throw new JwtError('config', 'The algorithm "none" is not allowed. Choose an HS, RS, PS or ES algorithm');
  }
  if (!(JWT_ALGORITHMS as readonly string[]).includes(algorithm)) {
    throw new JwtError('config', `The algorithm "${algorithm.slice(0, 20)}" is not supported`);
  }
  return algorithm as JwtAlgorithm;
}

const family = (alg: JwtAlgorithm) => alg.slice(0, 2) as 'HS' | 'RS' | 'PS' | 'ES';
const digestOf = (alg: JwtAlgorithm) => `sha${alg.slice(2)}`;

function hmacSecret(key: JwtKey): Buffer {
  const secret = key.secret ?? '';
  if (!secret) throw new JwtError('config', 'The credential has no secret');
  if (/-----BEGIN [A-Z0-9 ]+-----/.test(secret)) {
    throw new JwtError(
      'config',
      'The secret looks like a PEM key. Use the PEM key type with an RS, PS or ES algorithm',
    );
  }
  return Buffer.from(secret, 'utf8');
}

function checkKeyFits(alg: JwtAlgorithm, key: KeyObject): void {
  const fam = family(alg);
  if (fam === 'RS' || fam === 'PS') {
    if (key.asymmetricKeyType !== 'rsa')
      throw new JwtError('config', `The ${alg} algorithm needs an RSA key`);
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new JwtError('config', 'The RSA key must be at least 2048 bits');
    }
    return;
  }
  if (key.asymmetricKeyType !== 'ec') throw new JwtError('config', `The ${alg} algorithm needs an EC key`);
  if (key.asymmetricKeyDetails?.namedCurve !== CURVES[alg]) {
    throw new JwtError('config', `The ${alg} algorithm needs a ${CURVE_NAMES[alg]} key`);
  }
}

function loadKey(alg: JwtAlgorithm, pemText: string | undefined, kind: 'private' | 'public'): KeyObject {
  if (!pemText?.trim()) throw new JwtError('config', `The credential has no ${kind} key`);
  let key: KeyObject;
  try {
    const pem = formatPemBlock(pemText);
    key = kind === 'private' ? createPrivateKey(pem) : createPublicKey(pem);
  } catch {
    throw new JwtError('config', `The ${kind} key could not be read. Check that it is a valid PEM key`);
  }
  checkKeyFits(alg, key);
  return key;
}

function pssOptions(alg: JwtAlgorithm) {
  return { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: Number(alg.slice(2)) / 8 };
}

function signature(alg: JwtAlgorithm, input: string, key: JwtKey): Buffer {
  const fam = family(alg);
  if (fam === 'HS') return createHmac(digestOf(alg), hmacSecret(key)).update(input).digest();
  const k = loadKey(alg, key.privateKey, 'private');
  const data = Buffer.from(input);
  if (fam === 'RS') return cryptoSign(digestOf(alg), data, k);
  if (fam === 'PS') return cryptoSign(digestOf(alg), data, { key: k, ...pssOptions(alg) });
  return cryptoSign(digestOf(alg), data, { key: k, dsaEncoding: 'ieee-p1363' });
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

export interface SignInput {
  payload: Record<string, unknown>;
  algorithm: string;
  key: JwtKey;
  /** extra header fields; alg is always the pinned algorithm */
  header?: Record<string, unknown>;
  kid?: string;
  /** clock for the iat claim; Date.now() when absent */
  nowMs?: number;
}

export function signJwt(input: SignInput): string {
  const alg = checkAlgorithm(input.algorithm);
  // typ can be set by header claims (for example dpop+jwt); alg stays pinned to the checked algorithm
  const header: Record<string, unknown> = { typ: 'JWT', ...input.header, alg };
  if (input.kid) header.kid = input.kid;
  const payload = { ...input.payload };
  if (payload.iat === undefined) payload.iat = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const signingInput = `${encode(header)}.${encode(payload)}`;
  return `${signingInput}.${signature(alg, signingInput, input.key).toString('base64url')}`;
}

function parseJsonPart(part: string): Record<string, unknown> {
  if (!BASE64URL.test(part)) throw new JwtError('malformed', 'jwt malformed');
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // falls through
  }
  throw new JwtError('malformed', 'jwt malformed');
}

/** Split and parse a token. The signature is not checked. */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.trim().split('.');
  if (parts.length !== 3 || !BASE64URL.test(parts[2])) throw new JwtError('malformed', 'jwt malformed');
  return { header: parseJsonPart(parts[0]), payload: parseJsonPart(parts[1]), signature: parts[2] };
}

export interface VerifyInput {
  token: string;
  algorithm: string;
  key: JwtKey;
  ignoreExpiration?: boolean;
  ignoreNotBefore?: boolean;
  /** seconds */
  clockTolerance?: number;
  nowMs?: number;
}

export function verifyJwt(input: VerifyInput): DecodedJwt {
  const alg = checkAlgorithm(input.algorithm);
  const decoded = decodeJwt(input.token);
  if (decoded.header.alg !== alg) throw new JwtError('algorithm', 'invalid algorithm');
  if (decoded.header.crit !== undefined) throw new JwtError('malformed', 'unsupported crit header');

  const [head, body] = input.token.trim().split('.');
  const signingInput = `${head}.${body}`;
  const given = Buffer.from(decoded.signature, 'base64url');
  const fam = family(alg);
  let ok: boolean;
  if (fam === 'HS') {
    const expected = createHmac(digestOf(alg), hmacSecret(input.key)).update(signingInput).digest();
    ok = given.length === expected.length && timingSafeEqual(given, expected);
  } else {
    const k = loadKey(alg, input.key.publicKey, 'public');
    const data = Buffer.from(signingInput);
    if (fam === 'RS') ok = cryptoVerify(digestOf(alg), data, k, given);
    else if (fam === 'PS') ok = cryptoVerify(digestOf(alg), data, { key: k, ...pssOptions(alg) }, given);
    else ok = cryptoVerify(digestOf(alg), data, { key: k, dsaEncoding: 'ieee-p1363' }, given);
  }
  if (!ok) throw new JwtError('signature', 'invalid signature');

  const nowS = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const tolerance = Number(input.clockTolerance) || 0;
  const { exp, nbf } = decoded.payload;
  // a present but non-numeric claim must not read as "no expiry" (jsonwebtoken refuses it too)
  if (nbf !== undefined && !input.ignoreNotBefore && !(typeof nbf === 'number' && Number.isFinite(nbf))) {
    throw new JwtError('claims', 'invalid nbf value');
  }
  if (exp !== undefined && !input.ignoreExpiration && !(typeof exp === 'number' && Number.isFinite(exp))) {
    throw new JwtError('claims', 'invalid exp value');
  }
  if (typeof nbf === 'number' && !input.ignoreNotBefore && nbf > nowS + tolerance) {
    throw new JwtError('claims', 'jwt not active');
  }
  if (typeof exp === 'number' && !input.ignoreExpiration && nowS >= exp + tolerance) {
    throw new JwtError('claims', 'jwt expired');
  }
  return decoded;
}
