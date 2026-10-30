import { createHmac } from 'node:crypto';
import { createWebhookContext, WorkflowExecute } from '@workflow/core';
import {
  type DataObject,
  ExpressionEvaluator,
  type Item,
  type WebhookRequest,
  Workflow,
} from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '../src';
import { node, nodeTypes, runNode, testServices } from './harness';
import { json, localHttp, startHttpServer, startSmtpServer } from './servers';

const items = (...list: object[]): Item[] => list.map((j) => ({ json: j as DataObject }));

let server: Awaited<ReturnType<typeof startHttpServer>>;
const services = () => ({ http: localHttp() });

beforeAll(async () => {
  let flaky = 0;
  server = await startHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    switch (url.pathname) {
      case '/echo':
        return json(res, {
          method: req.method,
          query: Object.fromEntries(url.searchParams),
          headers: req.headers,
          body: req.body.toString('utf8'),
        });
      case '/list':
        return json(res, [{ id: 1 }, { id: 2 }]);
      case '/text':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('plain text');
      case '/file':
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-disposition': 'attachment; filename="pic.png"',
        });
        return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
      case '/missing':
        return json(res, { message: 'Not here' }, 404);
      case '/boom':
        return json(res, { error: { message: 'Internal failure' } }, 500);
      case '/slow':
        await new Promise((r) => setTimeout(r, 500));
        return json(res, {});
      case '/flaky':
        flaky++;
        return flaky % 2 ? json(res, { error: 'try again' }, 503) : json(res, { ok: true });
      case '/pages': {
        const page = Number(url.searchParams.get('page') ?? 1);
        return json(res, page <= 3 ? [{ page }] : []);
      }
      case '/cursor': {
        const cursor = url.searchParams.get('cursor');
        const next = cursor === null ? 'b' : cursor === 'b' ? 'c' : null;
        return json(res, {
          items: [{ cursor: cursor ?? 'a' }],
          next: next ? `/cursor?cursor=${next}` : null,
          has_more: !!next,
        });
      }
      case '/until404': {
        const page = Number(url.searchParams.get('page') ?? 1);
        return page > 2 ? json(res, { error: 'none' }, 404) : json(res, { page });
      }
      case '/token':
        return json(res, { access_token: 'tok-123', expires_in: 3600, token_type: 'bearer' });
      case '/graphql': {
        const payload =
          req.method === 'GET'
            ? {
                query: url.searchParams.get('query'),
                variables: JSON.parse(url.searchParams.get('variables') ?? '{}'),
              }
            : JSON.parse(req.body.toString('utf8'));
        if (String(payload.query).includes('fail'))
          return json(res, { errors: [{ message: 'Field "fail" is unknown' }] });
        return json(res, { data: { order: { id: payload.variables.id, total: 10 } } });
      }
      case '/rss':
        res.writeHead(200, { 'content-type': 'application/rss+xml' });
        return res.end(`<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
          <channel><title>Blog</title><link>https://blog.example.com</link>
          <item><title>First &amp; best</title><link>https://blog.example.com/1</link><pubDate>Tue, 01 Oct 2024 10:00:00 GMT</pubDate>
            <dc:creator>Ada</dc:creator><content:encoded><![CDATA[<p>Hello <b>world</b></p>]]></content:encoded><guid>p1</guid><category>news</category><category>tech</category></item>
          <item><title>Second</title><link>https://blog.example.com/2</link><description>Short</description></item>
          </channel></rss>`);
      case '/atom':
        res.writeHead(200, { 'content-type': 'application/atom+xml' });
        return res.end(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom feed</title>
          <link href="https://atom.example.com/" rel="alternate"/>
          <entry><title>Entry</title><link href="https://atom.example.com/e1"/><id>urn:e1</id><updated>2024-05-01T00:00:00Z</updated>
            <summary>Sum</summary><author><name>Bob</name></author><category term="x"/></entry></feed>`);
      default:
        return json(res, { error: 'unknown route' }, 404);
    }
  });
});

afterAll(async () => {
  await server.close();
});

describe('HTTP Request', () => {
  it('sends query parameters and headers and returns JSON', async () => {
    const r = await runNode(
      'core.httpRequest',
      {
        url: `${server.url}/echo`,
        sendQuery: true,
        queryParameters: { parameters: [{ name: 'q', value: '={{ $json.term }}' }] },
        sendHeaders: true,
        specifyHeaders: 'json',
        jsonHeaders: '{"X-Trace": "abc"}',
      },
      items({ term: 'pens' }),
      { services: services() },
    );
    expect(r.status).toBe('success');
    expect(r.outputs[0][0]).toMatchObject({
      method: 'GET',
      query: { q: 'pens' },
      headers: { 'x-trace': 'abc' },
    });
    expect(r.items[0][0].pairedItem).toEqual({ item: 0 });
  });

  it('is blocked from loopback addresses by the default SSRF policy', async () => {
    const r = await runNode('core.httpRequest', { url: `${server.url}/echo` });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('SSRF_BLOCKED');
    expect(server.requests.some((q) => q.headers['x-should-not-arrive'])).toBe(false);
  });

  it('rejects non-http URLs', async () => {
    const r = await runNode('core.httpRequest', { url: 'file:///etc/passwd' }, items({}), {
      services: services(),
    });
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/must start with http/);
  });

  it('splits JSON arrays into items', async () => {
    const r = await runNode('core.httpRequest', { url: `${server.url}/list` }, items({}), {
      services: services(),
    });
    expect(r.outputs[0]).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('sends JSON, form, raw, multipart and binary bodies', async () => {
    const jsonBody = await runNode(
      'core.httpRequest',
      {
        method: 'POST',
        url: `${server.url}/echo`,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ id: $json.id }) }}',
      },
      items({ id: 5 }),
      { services: services() },
    );
    expect(jsonBody.outputs[0][0]).toMatchObject({
      body: '{"id":5}',
      headers: { 'content-type': 'application/json' },
    });

    const form = await runNode(
      'core.httpRequest',
      {
        method: 'POST',
        url: `${server.url}/echo`,
        sendBody: true,
        contentType: 'form-urlencoded',
        bodyParameters: {
          parameters: [
            { name: 'a', value: '1' },
            { name: 'b', value: 'x y' },
          ],
        },
      },
      items({}),
      { services: services() },
    );
    expect(form.outputs[0][0]).toMatchObject({ body: 'a=1&b=x+y' });

    const raw = await runNode(
      'core.httpRequest',
      {
        method: 'PUT',
        url: `${server.url}/echo`,
        sendBody: true,
        contentType: 'raw',
        rawContentType: 'text/xml',
        body: '<a/>',
      },
      items({}),
      { services: services() },
    );
    expect(raw.outputs[0][0]).toMatchObject({
      method: 'PUT',
      body: '<a/>',
      headers: { 'content-type': 'text/xml' },
    });

    const file: Item = {
      json: {},
      binary: {
        doc: {
          data: Buffer.from('file-content').toString('base64'),
          mimeType: 'text/plain',
          fileName: 'a.txt',
        },
      },
    };
    const multipart = await runNode(
      'core.httpRequest',
      {
        method: 'POST',
        url: `${server.url}/echo`,
        sendBody: true,
        contentType: 'multipart-form-data',
        bodyParameters: {
          parameters: [
            { parameterType: 'formData', name: 'title', value: 'Report' },
            { parameterType: 'formBinaryData', name: 'upload', inputDataFieldName: 'doc' },
          ],
        },
      },
      [file],
      { services: services() },
    );
    const body = String(multipart.outputs[0][0].body);
    expect(body).toContain('name="title"');
    expect(body).toContain('Report');
    expect(body).toContain('filename="a.txt"');
    expect(body).toContain('file-content');

    const binary = await runNode(
      'core.httpRequest',
      {
        method: 'POST',
        url: `${server.url}/echo`,
        sendBody: true,
        contentType: 'binaryData',
        inputDataFieldName: 'doc',
      },
      [file],
      { services: services() },
    );
    expect(binary.outputs[0][0]).toMatchObject({
      body: 'file-content',
      headers: { 'content-type': 'text/plain' },
    });
  });

  it('applies every generic credential type', async () => {
    const send = (genericAuthType: string, creds: DataObject) =>
      runNode(
        'core.httpRequest',
        { url: `${server.url}/echo`, authentication: 'genericCredentialType', genericAuthType },
        items({}),
        { services: services(), creds: { [genericAuthType]: creds } },
      );
    const basic = await send('httpBasicAuth', { user: 'u', password: 'p' });
    expect((basic.outputs[0][0].headers as DataObject).authorization).toBe(
      `Basic ${Buffer.from('u:p').toString('base64')}`,
    );
    const header = await send('httpHeaderAuth', { name: 'X-Api-Key', value: 'k1' });
    expect((header.outputs[0][0].headers as DataObject)['x-api-key']).toBe('k1');
    const query = await send('httpQueryAuth', { name: 'api_key', value: 'k2' });
    expect(query.outputs[0][0].query).toEqual({ api_key: 'k2' });
    const bearer = await send('httpBearerAuth', { token: 't3' });
    expect((bearer.outputs[0][0].headers as DataObject).authorization).toBe('Bearer t3');
    const custom = await send('httpCustomAuth', { json: '{"headers":{"X-A":"1"},"qs":{"b":"2"}}' });
    expect(custom.outputs[0][0]).toMatchObject({ headers: { 'x-a': '1' }, query: { b: '2' } });
    const badCustom = await send('httpCustomAuth', { json: '{"cookies":{}}' });
    expect(badCustom.status).toBe('error');
    expect(badCustom.error?.message).toMatch(/only "headers", "qs" and "body"/);
  });

  it('gets OAuth2 client-credentials tokens and reuses predefined credential types', async () => {
    const updates: DataObject[] = [];
    const oauth = await runNode(
      'core.httpRequest',
      { url: `${server.url}/echo`, authentication: 'genericCredentialType', genericAuthType: 'oAuth2Api' },
      items({}),
      {
        services: {
          http: localHttp(),
          credentials: {
            get: async () => ({
              grantType: 'clientCredentials',
              accessTokenUrl: `${server.url}/token`,
              clientId: 'c',
              clientSecret: 's',
            }),
            update: async (_ref, _type, data) => void updates.push(data),
          },
        },
        creds: { oAuth2Api: {} },
      },
    );
    expect((oauth.outputs[0][0].headers as DataObject).authorization).toBe('Bearer tok-123');
    expect(updates).toHaveLength(1);

    const notion = await runNode(
      'core.httpRequest',
      {
        url: `${server.url}/echo`,
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'notionApi',
      },
      items({}),
      { services: services(), creds: { notionApi: { apiKey: 'ntn_1' } } },
    );
    expect(notion.outputs[0][0].headers).toMatchObject({
      authorization: 'Bearer ntn_1',
      'notion-version': '2022-06-28',
    });
  });

  it('returns full responses, text and files', async () => {
    const full = await runNode(
      'core.httpRequest',
      { url: `${server.url}/list`, options: { response: { response: { fullResponse: true } } } },
      items({}),
      { services: services() },
    );
    expect(full.outputs[0][0]).toMatchObject({
      body: [{ id: 1 }, { id: 2 }],
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
    });
    const text = await runNode('core.httpRequest', { url: `${server.url}/text` }, items({}), {
      services: services(),
    });
    expect(text.outputs[0]).toEqual([{ data: 'plain text' }]);
    const file = await runNode('core.httpRequest', { url: `${server.url}/file` }, items({}), {
      services: services(),
    });
    expect(file.items[0][0].binary?.data).toMatchObject({
      mimeType: 'image/png',
      fileName: 'pic.png',
      fileSize: 6,
    });
    const forcedText = await runNode(
      'core.httpRequest',
      {
        url: `${server.url}/list`,
        options: { response: { response: { responseFormat: 'text', outputPropertyName: 'raw' } } },
      },
      items({}),
      { services: services() },
    );
    expect(forcedText.outputs[0]).toEqual([{ raw: '[{"id":1},{"id":2}]' }]);
  });

  it('fails on error statuses unless never-error is set, and reports the error code', async () => {
    const failed = await runNode('core.httpRequest', { url: `${server.url}/boom` }, items({}), {
      services: services(),
    });
    expect(failed.status).toBe('error');
    expect(failed.error).toMatchObject({ message: 'Internal failure', code: 'HTTP_500', httpCode: '500' });
    const never = await runNode(
      'core.httpRequest',
      {
        url: `${server.url}/missing`,
        options: { response: { response: { neverError: true, fullResponse: true } } },
      },
      items({}),
      { services: services() },
    );
    expect(never.outputs[0][0]).toMatchObject({ statusCode: 404, body: { message: 'Not here' } });
  });

  it('continues on fail per item and retries flaky calls', async () => {
    const r = await runNode(
      'core.httpRequest',
      { url: '={{ $json.url }}' },
      items({ url: `${server.url}/boom` }, { url: `${server.url}/list` }),
      {
        services: services(),
        node: { onError: 'continueRegularOutput' },
      },
    );
    expect(r.outputs[0]).toEqual([{ error: 'Internal failure' }, { id: 1 }, { id: 2 }]);
    const retried = await runNode('core.httpRequest', { url: `${server.url}/flaky` }, items({}), {
      services: services(),
      node: { retryOnFail: true, maxTries: 3, waitBetweenTries: 10 },
    });
    expect(retried.outputs[0]).toEqual([{ ok: true }]);
  });

  it('honours the timeout option', async () => {
    const r = await runNode(
      'core.httpRequest',
      { url: `${server.url}/slow`, options: { timeout: 50 } },
      items({}),
      { services: services() },
    );
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('TIMEOUT');
  });

  it('sends a stable idempotency key per execution, node and item', async () => {
    const params = { method: 'POST', url: `${server.url}/echo`, options: { idempotencyKey: true } };
    const first = await runNode('core.httpRequest', params, items({ a: 1 }, { a: 2 }), {
      services: services(),
    });
    const again = await runNode('core.httpRequest', params, items({ a: 1 }), { services: services() });
    const keys = first.outputs[0].map((o) => (o.headers as DataObject)['idempotency-key']);
    expect(keys[0]).toMatch(/^[0-9a-f]{40}$/);
    expect(keys[0]).not.toBe(keys[1]);
    expect((again.outputs[0][0].headers as DataObject)['idempotency-key']).toBe(keys[0]);
    const other = await runNode('core.httpRequest', params, items({ a: 1 }), {
      services: { ...services(), executionId: 'e2' },
    });
    expect((other.outputs[0][0].headers as DataObject)['idempotency-key']).not.toBe(keys[0]);
    // a different request for the same item (e.g. the next round of a loop) gets a new key
    const otherBody = await runNode(
      'core.httpRequest',
      { ...params, sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify({ round: 2 }) }}' },
      items({ a: 1 }),
      { services: services() },
    );
    expect((otherBody.outputs[0][0].headers as DataObject)['idempotency-key']).not.toBe(keys[0]);
    // an explicit header wins
    const explicit = await runNode(
      'core.httpRequest',
      {
        ...params,
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'Idempotency-Key', value: 'mine' }] },
      },
      items({ a: 1 }),
      { services: services() },
    );
    expect((explicit.outputs[0][0].headers as DataObject)['idempotency-key']).toBe('mine');
  });

  it('keeps the idempotency key when the execution is retried from the failed node', async () => {
    const seen: string[] = [];
    const flaky = await startHttpServer((req, res) => {
      seen.push(String(req.headers['idempotency-key']));
      return seen.length === 1 ? json(res, { error: 'gateway timeout' }, 504) : json(res, { charged: true });
    });
    try {
      const definition = {
        name: 'charge',
        nodes: [
          node('Start', 'core.manualTrigger'),
          node(
            'Charge',
            'core.httpRequest',
            { method: 'POST', url: `${flaky.url}/charge`, options: { idempotencyKey: true } },
            [200, 0],
          ),
        ],
        connections: { Start: { main: [[{ node: 'Charge', type: 'main' as const, index: 0 }]] } },
      };
      const first = await new WorkflowExecute(
        new Workflow(definition, nodeTypes),
        testServices({}, services()),
      ).run();
      expect(first.status).toBe('error');
      const persisted = JSON.parse(JSON.stringify(first.state));
      const retried = await new WorkflowExecute(
        new Workflow(definition, nodeTypes),
        testServices({}, services()),
        persisted,
      ).retryFromFailure();
      expect(retried.status).toBe('success');
      expect(seen).toHaveLength(2);
      expect(seen[0]).toBe(seen[1]);
    } finally {
      await flaky.close();
    }
  });

  it('batches requests with an interval', async () => {
    const started = Date.now();
    const r = await runNode(
      'core.httpRequest',
      { url: `${server.url}/echo`, options: { batching: { batch: { batchSize: 2, batchInterval: 80 } } } },
      items({}, {}, {}, {}, {}),
      { services: services() },
    );
    expect(r.outputs[0]).toHaveLength(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(r.items[0].map((i) => i.pairedItem)).toEqual([0, 1, 2, 3, 4].map((item) => ({ item })));
  });

  describe('pagination', () => {
    const paginate = (pagination: DataObject, url = `${server.url}/pages`) =>
      runNode('core.httpRequest', { url, options: { pagination: { pagination } } }, items({}), {
        services: services(),
      });

    it('updates a parameter until the response is empty', async () => {
      const r = await paginate({
        paginationMode: 'updateAParameterInEachRequest',
        parameters: { parameters: [{ type: 'qs', name: 'page', value: '={{ $pageCount + 1 }}' }] },
        paginationCompleteWhen: 'responseIsEmpty',
      });
      expect(r.outputs[0]).toEqual([{ page: 1 }, { page: 2 }, { page: 3 }]);
    });

    it('follows the next URL in the response until a complete expression is true', async () => {
      const r = await paginate(
        {
          paginationMode: 'responseContainsNextURL',
          nextURL: '={{ $response.body.next }}',
          paginationCompleteWhen: 'other',
          completeExpression: '={{ !$response.body.has_more }}',
        },
        `${server.url}/cursor`,
      );
      expect(r.outputs[0].map((o) => (o.items as DataObject[])[0].cursor)).toEqual(['a', 'b', 'c']);
    });

    it('stops on specific status codes and respects a page limit', async () => {
      const byStatus = await paginate(
        {
          paginationMode: 'updateAParameterInEachRequest',
          parameters: { parameters: [{ type: 'qs', name: 'page', value: '={{ $pageCount + 1 }}' }] },
          paginationCompleteWhen: 'receiveSpecificStatusCodes',
          statusCodesWhenComplete: '404',
        },
        `${server.url}/until404`,
      );
      expect(byStatus.outputs[0]).toEqual([{ page: 1 }, { page: 2 }]);
      const limited = await paginate({
        paginationMode: 'updateAParameterInEachRequest',
        parameters: { parameters: [{ type: 'qs', name: 'page', value: '={{ $pageCount + 1 }}' }] },
        limitPagesFetched: true,
        maxRequests: 2,
      });
      expect(limited.outputs[0]).toEqual([{ page: 1 }, { page: 2 }]);
    });

    it('detects pagination that does not advance', async () => {
      const r = await paginate({
        paginationMode: 'updateAParameterInEachRequest',
        parameters: { parameters: [{ type: 'qs', name: 'page', value: '1' }] },
      });
      expect(r.status).toBe('error');
      expect(r.error?.message).toMatch(/not advancing/);
    });

    it('never evaluates response data as an expression', async () => {
      const evil = await startHttpServer((_req, res) =>
        json(res, { next: '={{ $json.secret }}', items: [] }),
      );
      try {
        const r = await runNode(
          'core.httpRequest',
          {
            url: `${evil.url}/x`,
            options: {
              pagination: {
                pagination: {
                  paginationMode: 'responseContainsNextURL',
                  nextURL: '={{ $response.body.next }}',
                  limitPagesFetched: true,
                  maxRequests: 2,
                },
              },
            },
          },
          items({ secret: 'top-secret' }),
          { services: services() },
        );
        // the "next URL" is the literal text, resolved relative to the server, not the secret
        expect(evil.requests.map((q) => decodeURIComponent(q.url))).toEqual(['/x', '/={{ $json.secret }}']);
        expect(r.status).toBe('success');
      } finally {
        await evil.close();
      }
    });
  });
});

describe('GraphQL', () => {
  it('posts the query and variables', async () => {
    const r = await runNode(
      'core.graphql',
      {
        endpoint: `${server.url}/graphql`,
        query: 'query ($id: ID!) { order(id: $id) { id total } }',
        variables: '={{ JSON.stringify({ id: $json.orderId }) }}',
        options: { onlyData: true },
      },
      items({ orderId: 'o1' }),
      { services: services() },
    );
    expect(r.outputs[0]).toEqual([{ order: { id: 'o1', total: 10 } }]);
    const posted = JSON.parse(server.requests.at(-1)!.body.toString());
    expect(posted.variables).toEqual({ id: 'o1' });
  });

  it('supports GET requests and header auth', async () => {
    const r = await runNode(
      'core.graphql',
      {
        requestMethod: 'GET',
        endpoint: `${server.url}/graphql`,
        query: '{ order { id } }',
        variables: '{"id": 2}',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
      },
      items({}),
      { services: services(), creds: { httpHeaderAuth: { name: 'X-Key', value: 'gql' } } },
    );
    expect(r.outputs[0][0]).toEqual({ data: { order: { id: 2, total: 10 } } });
    expect(server.requests.at(-1)!.headers['x-key']).toBe('gql');
  });

  it('turns GraphQL errors into node errors', async () => {
    const r = await runNode(
      'core.graphql',
      { endpoint: `${server.url}/graphql`, query: '{ fail }' },
      items({}),
      { services: services() },
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('Field "fail" is unknown');
    const ignored = await runNode(
      'core.graphql',
      { endpoint: `${server.url}/graphql`, query: '{ fail }', options: { ignoreGraphqlErrors: true } },
      items({}),
      { services: services() },
    );
    expect(ignored.outputs[0][0].errors).toHaveLength(1);
  });
});

describe('RSS Read', () => {
  it('reads RSS 2.0 feeds', async () => {
    const r = await runNode('core.rssFeedRead', { url: `${server.url}/rss` }, items({}), {
      services: services(),
    });
    expect(r.outputs[0]).toHaveLength(2);
    expect(r.outputs[0][0]).toMatchObject({
      title: 'First & best',
      link: 'https://blog.example.com/1',
      isoDate: '2024-10-01T10:00:00.000Z',
      author: 'Ada',
      contentSnippet: 'Hello world',
      guid: 'p1',
      categories: ['news', 'tech'],
    });
  });

  it('reads Atom feeds and adds feed info', async () => {
    const r = await runNode(
      'core.rssFeedRead',
      { url: `${server.url}/atom`, options: { includeFeed: true } },
      items({}),
      { services: services() },
    );
    expect(r.outputs[0]).toEqual([
      expect.objectContaining({
        title: 'Entry',
        link: 'https://atom.example.com/e1',
        guid: 'urn:e1',
        author: 'Bob',
        categories: ['x'],
        feed: expect.objectContaining({ title: 'Atom feed', link: 'https://atom.example.com/' }),
      }),
    ]);
  });

  it('rejects documents that are not feeds', async () => {
    const r = await runNode('core.rssFeedRead', { url: `${server.url}/list` }, items({}), {
      services: services(),
    });
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/not an RSS or Atom feed/);
  });
});

describe('Send Email', () => {
  it('sends through SMTP with attachments once the host is allowed', async () => {
    const smtp = await startSmtpServer();
    try {
      const r = await runNode(
        'core.sendEmail',
        {
          fromEmail: 'Ada <ada@example.com>',
          toEmail: '={{ $json.to }}',
          subject: 'Invoice\r\nBcc: victim@example.com',
          emailFormat: 'both',
          text: 'Hello',
          html: '<p>Hello</p>',
          options: { attachments: 'invoice', ccEmail: 'cc@example.com' },
        },
        [
          {
            json: { to: 'bob@example.com' },
            binary: {
              invoice: {
                data: Buffer.from('PDF!').toString('base64'),
                mimeType: 'application/pdf',
                fileName: 'inv.pdf',
              },
            },
          },
        ],
        {
          services: services(),
          creds: {
            smtp: {
              host: '127.0.0.1',
              port: smtp.port,
              secure: false,
              disableStartTls: true,
              user: 'ada',
              password: 'pw',
            },
          },
        },
      );
      expect(r.status).toBe('success');
      expect(r.outputs[0][0]).toMatchObject({
        accepted: ['bob@example.com', 'cc@example.com'],
        response: expect.stringMatching(/250/),
      });
      expect(smtp.messages).toHaveLength(1);
      const message = smtp.messages[0];
      expect(message.auth).toBe('\u0000ada\u0000pw');
      expect(message.data).toMatch(/Subject: Invoice Bcc: victim@example.com/);
      expect(message.data).not.toMatch(/^Bcc:/m);
      expect(message.data).toContain('inv.pdf');
    } finally {
      await smtp.close();
    }
  });

  it('refuses private SMTP hosts under the default SSRF policy', async () => {
    const smtp = await startSmtpServer();
    try {
      const r = await runNode(
        'core.sendEmail',
        { fromEmail: 'a@example.com', toEmail: 'b@example.com' },
        items({}),
        {
          creds: { smtp: { host: '127.0.0.1', port: smtp.port, secure: false } },
        },
      );
      expect(r.status).toBe('error');
      expect(r.error?.code).toBe('SSRF_BLOCKED');
      expect(smtp.messages).toHaveLength(0);
    } finally {
      await smtp.close();
    }
  });
});

describe('Webhook', () => {
  const call = async (
    parameters: DataObject,
    request: Partial<WebhookRequest>,
    creds: Record<string, DataObject> = {},
  ) => {
    const wfNode = node('Webhook', 'core.webhook', parameters, [0, 0], {
      credentials: Object.fromEntries(Object.keys(creds).map((k) => [k, { id: k, name: k }])),
    });
    const workflow = new Workflow({ name: 'w', nodes: [wfNode], connections: {} }, nodeTypes);
    const ctx = createWebhookContext(
      {
        workflow,
        node: wfNode,
        services: testServices(creds),
        evaluator: new ExpressionEvaluator(),
        signal: new AbortController().signal,
      },
      { method: 'POST', headers: {}, query: {}, params: {}, body: {}, ...request },
      'default',
    );
    return nodeTypes.get('core.webhook')!.webhook!(ctx);
  };

  it('returns the request as an item and checks basic auth', async () => {
    const ok = await call(
      { authentication: 'basicAuth' },
      { headers: { authorization: `Basic ${Buffer.from('u:p').toString('base64')}` }, body: { a: 1 } },
      { httpBasicAuth: { user: 'u', password: 'p' } },
    );
    expect(ok.workflowData?.[0][0].json).toMatchObject({ body: { a: 1 } });
    const denied = await call(
      { authentication: 'basicAuth' },
      { headers: {} },
      { httpBasicAuth: { user: 'u', password: 'p' } },
    );
    expect(denied.webhookResponse?.statusCode).toBe(401);
  });

  it('verifies GitHub, Stripe, Slack, Shopify and custom HMAC signatures', async () => {
    const secret = 'whsec_test';
    const raw = Buffer.from('{"event":"paid"}');
    const now = Math.floor(Date.now() / 1000);
    const sign = (data: string | Buffer, encoding: 'hex' | 'base64' = 'hex') =>
      createHmac('sha256', secret).update(data).digest(encoding);
    const creds = { webhookSigningSecret: { secret } };
    const github = await call(
      { authentication: 'signature', signaturePreset: 'github' },
      { rawBody: raw, headers: { 'x-hub-signature-256': `sha256=${sign(raw)}` } },
      creds,
    );
    expect(github.workflowData).toBeDefined();
    const stripe = await call(
      { authentication: 'signature', signaturePreset: 'stripe' },
      { rawBody: raw, headers: { 'stripe-signature': `t=${now},v1=${sign(`${now}.${raw}`)}` } },
      creds,
    );
    expect(stripe.workflowData).toBeDefined();
    const slack = await call(
      { authentication: 'signature', signaturePreset: 'slack' },
      {
        rawBody: raw,
        headers: {
          'x-slack-request-timestamp': String(now),
          'x-slack-signature': `v0=${sign(`v0:${now}:${raw}`)}`,
        },
      },
      creds,
    );
    expect(slack.workflowData).toBeDefined();
    const shopify = await call(
      { authentication: 'signature', signaturePreset: 'shopify' },
      { rawBody: raw, headers: { 'x-shopify-hmac-sha256': sign(raw, 'base64') } },
      creds,
    );
    expect(shopify.workflowData).toBeDefined();
    const custom = await call(
      {
        authentication: 'signature',
        signaturePreset: 'generic',
        signatureHeader: 'X-Sig',
        signaturePrefix: 'hmac=',
      },
      { rawBody: raw, headers: { 'x-sig': `hmac=${sign(raw)}` } },
      creds,
    );
    expect(custom.workflowData).toBeDefined();
  });

  it('rejects tampered, stale and unverifiable deliveries', async () => {
    const secret = 's';
    const raw = Buffer.from('{}');
    const creds = { webhookSigningSecret: { secret } };
    const tampered = await call(
      { authentication: 'signature', signaturePreset: 'github' },
      {
        rawBody: Buffer.from('{"x":1}'),
        headers: {
          'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
        },
      },
      creds,
    );
    expect(tampered.webhookResponse).toMatchObject({
      statusCode: 401,
      body: { message: 'Invalid signature' },
    });
    const old = Math.floor(Date.now() / 1000) - 3600;
    const stale = await call(
      { authentication: 'signature', signaturePreset: 'stripe' },
      {
        rawBody: raw,
        headers: {
          'stripe-signature': `t=${old},v1=${createHmac('sha256', secret).update(`${old}.{}`).digest('hex')}`,
        },
      },
      creds,
    );
    expect(stale.webhookResponse?.body).toEqual({ message: 'The request timestamp is missing or too old' });
    const noRaw = await call(
      { authentication: 'signature', signaturePreset: 'github' },
      { headers: {} },
      creds,
    );
    expect(noRaw.webhookResponse?.statusCode).toBe(401);
    expect(verifyWebhookSignature({ preset: 'github', secret: '', headers: {}, rawBody: raw })).toEqual({
      ok: false,
      reason: 'No signing secret is configured',
    });
  });
});
