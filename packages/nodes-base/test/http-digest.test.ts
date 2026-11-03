import { createHash } from 'node:crypto';
import type { DataObject } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNode } from './harness';
import { json, localHttp, startHttpServer } from './servers';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const USER = 'Mufasa';
const PASSWORD = 'Circle Of Life';
const REALM = 'test@realm';
const NONCE = 'dcd98b7102dd2f0e8b11d0f600bfb0c093';

/** the server's own check of the Authorization header (its own parse and arithmetic) */
function valid(header: string | undefined, method: string, uri: string, sess: boolean): boolean {
  if (!header?.startsWith('Digest ')) return false;
  const f: Record<string, string> = {};
  for (const m of header.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) f[m[1]] = m[2] ?? m[3];
  if (f.username !== USER || f.realm !== REALM || f.nonce !== NONCE || f.uri !== uri) return false;
  let ha1 = md5(`${USER}:${REALM}:${PASSWORD}`);
  if (sess) ha1 = md5(`${ha1}:${NONCE}:${f.cnonce}`);
  const ha2 = md5(`${method}:${uri}`);
  const expected = f.qop
    ? md5(`${ha1}:${NONCE}:${f.nc}:${f.cnonce}:${f.qop}:${ha2}`)
    : md5(`${ha1}:${NONCE}:${ha2}`);
  return f.response === expected && (!f.qop || f.nc === '00000001');
}

let server: Awaited<ReturnType<typeof startHttpServer>>;
const services = () => ({ http: localHttp() });

beforeAll(async () => {
  server = await startHttpServer((req, res) => {
    const path = req.url.split('?')[0];
    const sess = path === '/sess';
    const old = path === '/old';
    const challenge = old
      ? `Digest realm="${REALM}", nonce="${NONCE}"`
      : `Digest realm="${REALM}", qop="auth", nonce="${NONCE}", opaque="op"${sess ? ', algorithm=MD5-sess' : ''}`;
    if (!valid(req.headers.authorization, req.method, req.url, sess)) {
      return json(res, { error: 'unauthorized' }, 401, { 'www-authenticate': challenge });
    }
    return json(res, { ok: true, method: req.method, body: req.body.toString('utf8') });
  });
});
afterAll(async () => server.close());

const run = (params: DataObject, password = PASSWORD, genericAuthType = 'httpDigestAuth') =>
  runNode(
    'core.httpRequest',
    { authentication: 'genericCredentialType', genericAuthType, ...params },
    [{ json: {} }],
    { services: services(), creds: { [genericAuthType]: { user: USER, password } } },
  );

describe('HTTP Request with Digest Auth', () => {
  it('answers the challenge after exactly two requests, the first without Authorization', async () => {
    server.requests.length = 0;
    const out = await run({ url: `${server.url}/dir?a=1` });
    expect(out.status).toBe('success');
    expect(out.outputs[0][0]).toMatchObject({ ok: true, method: 'GET' });
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0].headers.authorization).toBeUndefined();
    expect(server.requests[1].headers.authorization).toMatch(/^Digest /);
    expect(server.requests[1].headers.authorization).toContain('uri="/dir?a=1"');
  });

  it('works with MD5-sess and with the RFC 2069 form', async () => {
    expect((await run({ url: `${server.url}/sess` })).outputs[0][0]).toMatchObject({ ok: true });
    expect((await run({ url: `${server.url}/old` })).outputs[0][0]).toMatchObject({ ok: true });
  });

  it('retries once with a wrong password, then errors', async () => {
    server.requests.length = 0;
    const out = await run({ url: `${server.url}/dir` }, 'wrong');
    expect(out.status).toBe('error');
    expect(out.error?.message).toMatch(/401|nauthorized/);
    expect(server.requests).toHaveLength(2);
  });

  it('re-sends a JSON POST body intact on the retry', async () => {
    server.requests.length = 0;
    const out = await run({
      method: 'POST',
      url: `${server.url}/dir`,
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ a: 1, b: "two" }) }}',
    });
    expect(out.outputs[0][0]).toMatchObject({ ok: true, method: 'POST' });
    expect(JSON.parse(out.outputs[0][0].body as string)).toEqual({ a: 1, b: 'two' });
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0].body.toString()).toBe(server.requests[1].body.toString());
    expect(server.requests[1].body.toString()).toBe('{"a":1,"b":"two"}');
  });

  it('keeps the full-response shape', async () => {
    const out = await run({
      url: `${server.url}/dir`,
      options: { response: { response: { fullResponse: true } } },
    });
    expect(out.outputs[0][0]).toMatchObject({ statusCode: 200, body: { ok: true } });
  });

  it('keeps the never-error shape on a wrong password', async () => {
    const out = await run(
      {
        url: `${server.url}/dir`,
        options: { response: { response: { neverError: true, fullResponse: true } } },
      },
      'wrong',
    );
    expect(out.status).toBe('success');
    expect(out.outputs[0][0]).toMatchObject({ statusCode: 401 });
  });

  it('is offered as a generic credential type', async () => {
    const { GENERIC_AUTH_TYPES } = await import('../src/utils/http');
    expect(GENERIC_AUTH_TYPES.map((t) => t.value)).toContain('httpDigestAuth');
  });
});
