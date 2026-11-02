import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../src';

interface Received {
  headers: http.IncomingHttpHeaders;
  rawHeaders: string[];
  body: string;
}

describe('R62: repeated names in form-urlencoded bodies, multipart bodies and headers', () => {
  const received: Received[] = [];
  let port = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    received.push({ headers: req.headers, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks).toString('utf8') });
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });
  const client = new HttpClient({ ssrf: { allow: ['localhost'] } });
  const url = () => `http://localhost:${port}/echo`;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it('sends every value of a repeated name in a form-urlencoded body', async () => {
    await client.request({
      url: url(),
      method: 'POST',
      bodyType: 'form-urlencoded',
      body: { status: ['open', 'pending'], page: 1, tags: [] },
    });
    expect(received.at(-1)?.body).toBe('status=open&status=pending&page=1');
  });

  it('sends every entry of a repeated name in a multipart body, files included', async () => {
    await client.request({
      url: url(),
      method: 'POST',
      bodyType: 'multipart',
      body: {
        tag: ['a', 'b'],
        file: [
          { data: new Uint8Array([65, 66]), fileName: 'one.txt', mimeType: 'text/plain' },
          { data: new Uint8Array([67, 68]), fileName: 'two.txt', mimeType: 'text/plain' },
        ],
        single: 'x',
      },
    });
    const body = received.at(-1)?.body ?? '';
    expect(body.match(/name="tag"/g)).toHaveLength(2);
    expect(body).toMatch(/name="tag"\r\n\r\na\r\n/);
    expect(body).toMatch(/name="tag"\r\n\r\nb\r\n/);
    expect(body).toContain('filename="one.txt"');
    expect(body).toContain('filename="two.txt"');
    expect(body).toContain('AB');
    expect(body).toContain('CD');
    expect(body).toMatch(/name="single"\r\n\r\nx\r\n/);
  });

  it('sends every value of a repeated header', async () => {
    await client.request({ url: url(), headers: { 'X-Dup': ['first', 'last'], 'x-one': 'solo' } });
    const { headers } = received.at(-1) as Received;
    expect(headers['x-dup']).toBe('first, last');
    expect(headers['x-one']).toBe('solo');
  });

  it('lets the later of two names that differ only in case replace the earlier one', async () => {
    await client.request({ url: url(), headers: { 'X-Dup': 'a', 'x-dup': ['b', 'c'] } });
    expect(received.at(-1)?.headers['x-dup']).toBe('b, c');
    await client.request({ url: url(), headers: { 'x-dup': ['a', 'b'], 'X-Dup': 'c' } });
    expect(received.at(-1)?.headers['x-dup']).toBe('c');
  });

  it('sends one value when a header overrides a default by spreading with other casing', async () => {
    // the HTTP Request node puts its raw body content type before the user's header rows
    const userHeaders: Record<string, string> = { 'Content-Type': 'application/xml', Authorization: 'user value' };
    await client.request({
      url: url(),
      method: 'POST',
      headers: { 'content-type': 'text/plain', ...userHeaders },
      body: '<a/>',
    });
    expect(received.at(-1)?.headers['content-type']).toBe('application/xml');
    // an OAuth2 credential adds its token after the user's headers
    await client.request({ url: url(), headers: { ...userHeaders, authorization: 'Bearer t' } });
    expect(received.at(-1)?.headers.authorization).toBe('Bearer t');
  });

  it('keeps a streamed response working with repeated headers and bodies', async () => {
    const res = await client.request<{ chunks: AsyncIterable<Uint8Array> | unknown }>({
      url: url(),
      method: 'POST',
      bodyType: 'form-urlencoded',
      body: { a: ['1', '2'] },
      headers: { 'x-dup': ['p', 'q'] },
      responseType: 'stream',
    });
    expect(res).toBeTruthy();
    expect(received.at(-1)?.body).toBe('a=1&a=2');
    expect(received.at(-1)?.headers['x-dup']).toBe('p, q');
  });
});
