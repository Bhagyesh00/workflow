/**
 * The Google service account JWT bearer grant. The assertion is RS256 on node:crypto. The token URL is
 * named by the caller: a key file's own `token_uri` is never read.
 */
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import type { HttpRequestOptions, JwtBearerInput } from '@workflow/workflow';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const ASSERTION_SECONDS = 3600;

const b64url = (data: string | Buffer): string => Buffer.from(data).toString('base64url');

function readKey(privateKey: string): KeyObject {
  try {
    // a key pasted from a JSON file often carries its new lines as the two characters \n
    return createPrivateKey(privateKey.replace(/\\n/g, '\n').trim());
  } catch {
    // the crypto error is not passed on: the text must never quote the key
    throw new Error('The service account private key is not valid');
  }
}

export function googleJwtAssertion(input: JwtBearerInput, now: Date = new Date()): string {
  const key = readKey(input.privateKey);
  const seconds = Math.floor(now.getTime() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: input.email,
      ...(input.subject ? { sub: input.subject } : {}),
      scope: input.scopes.join(' '),
      aud: input.tokenUrl ?? GOOGLE_TOKEN_URL,
      iat: seconds,
      exp: seconds + ASSERTION_SECONDS,
    }),
  );
  const signature = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key);
  return `${head}.${claims}.${b64url(signature)}`;
}

export function jwtBearerRequest(assertion: string, tokenUrl: string): HttpRequestOptions {
  return {
    url: tokenUrl,
    method: 'POST',
    bodyType: 'form-urlencoded',
    headers: { accept: 'application/json' },
    followRedirects: false,
    body: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion },
  };
}
