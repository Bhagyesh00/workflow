/**
 * AWS Signature Version 4 on node:crypto (P4-08). Checked against AWS's published test vectors. It signs
 * with the keys it is given and reads nothing from the host, so no host AWS identity is ever lent out.
 */
import { createHash, createHmac } from 'node:crypto';

export interface SigV4Input {
  method: string;
  url: string;
  /** signed as given, besides host and x-amz-date */
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** default: now */
  date?: Date;
}

export interface SigV4Result {
  /** the given headers plus x-amz-date, authorization and, with a session token, x-amz-security-token */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** RFC 3986 unreserved characters stay, everything else is %XX in upper case */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

export function signingKey(secretAccessKey: string, day: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, day);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function signAwsRequest(input: SigV4Input): SigV4Result {
  const url = new URL(input.url);
  const stamp = amzDate(input.date ?? new Date());
  const day = stamp.slice(0, 8);

  const headers: Record<string, string> = { ...input.headers, 'x-amz-date': stamp };
  if (input.sessionToken) headers['x-amz-security-token'] = input.sessionToken;

  // names in lower case, values trimmed with inner runs of spaces folded
  const signed = new Map<string, string>([['host', url.host]]);
  for (const [name, value] of Object.entries(headers)) {
    signed.set(name.toLowerCase(), value.trim().replace(/\s+/g, ' '));
  }
  const names = [...signed.keys()].sort(compare);
  const canonicalHeaders = names.map((n) => `${n}:${signed.get(n)}\n`).join('');
  const signedHeaders = names.join(';');

  // not S3: every path segment is encoded a second time
  const canonicalUri =
    url.pathname
      .split('/')
      .map((segment) => encodeRfc3986(segment))
      .join('/') || '/';
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    sha256Hex(input.body ?? ''),
  ].join('\n');

  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(input.secretAccessKey, day, input.region, input.service))
    .update(stringToSign)
    .digest('hex');

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalRequest, stringToSign, signature };
}
