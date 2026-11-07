import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpClient } from '@workflow/core';
import type { DataObject, WorkflowNode } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatSearXngReply } from '../src/nodes/tools/ToolSearXng.node';
import {
  connect,
  FakeHttpClient,
  type FakeHandler,
  modelRequests,
  node,
  run,
  scriptModel,
  services,
  toolCalls,
} from './harness';

/** An agent whose scripted model calls the one tool once; returns the observation and the model's tool list. */
async function ask(tool: WorkflowNode, args: DataObject, svc: ReturnType<typeof services>) {
  const requests = scriptModel('Model', [toolCalls([tool.name, args, 'c1']), 'done']);
  const r = await run(
    [
      node('Trigger', 'test.trigger'),
      node('Agent', 'ai.agent', { promptType: 'define', text: 'go', options: { returnIntermediateSteps: true } }),
      node('Model', 'test.fakeChatModel'),
      tool,
    ],
    connect(['Trigger', 'Agent'], ['Model', 'Agent', 'ai_languageModel'], [tool.name, 'Agent', 'ai_tool']),
    { services: svc },
  );
  const steps = (r.output('Agent')[0]?.intermediateSteps ?? []) as Array<{ observation: string }>;
  return { r, requests, observation: steps[0]?.observation ?? '' };
}

const fake = (handler: FakeHandler) => new FakeHttpClient(handler);

beforeEach(() => modelRequests.clear());

describe('SearXNG tool', () => {
  const searx = (parameters: DataObject = {}) =>
    node('Web_Search', 'ai.toolSearXng', parameters, { credentials: { searXngApi: { id: 'c', name: 's' } } });
  const creds = { searXngApi: { apiUrl: 'https://searx.example.com/' } };

  it('answers a recorded query with the first results as JSON strings', async () => {
    const client = fake(() => ({
      body: {
        results: [
          { title: 'A', url: 'https://a.example', content: 'about a', engine: 'x' },
          { title: 'B', url: 'https://b.example', content: 'about b' },
          { title: 'C', url: 'https://c.example', content: 'about c' },
        ],
      },
    }));
    const { r, requests, observation } = await ask(
      searx({ options: { numResults: 2, language: 'de', safesearch: 2, pageNumber: 3 } }),
      { query: 'current news' },
      services({ http: client, creds }),
    );
    expect(r.status).toBe('success');
    expect(requests[0].tools?.[0].name).toBe('Web_Search');
    expect(client.requests).toHaveLength(1);
    const sent = client.requests[0];
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('https://searx.example.com/search');
    expect(sent.qs).toEqual({ q: 'current news', format: 'json', pageno: 3, safesearch: 2, language: 'de' });
    expect(sent.timeout).toBe(15000);
    expect(observation).toBe(
      '{"title":"A","link":"https://a.example","snippet":"about a"},{"title":"B","link":"https://b.example","snippet":"about b"}',
    );
  });

  it('uses the defaults when no option is set', async () => {
    const client = fake(() => ({ body: { results: [] } }));
    await ask(searx(), { query: 'x' }, services({ http: client, creds }));
    expect(client.requests[0].qs).toEqual({ q: 'x', format: 'json', pageno: 1, safesearch: 0, language: 'en' });
  });

  it('falls back to the answer, the infobox text, the suggestions and the no-result text', () => {
    expect(formatSearXngReply({ results: [], answers: ['42', 'x'] }, 5)).toBe('42');
    expect(formatSearXngReply({ answers: [{ answer: 'forty-two' }] }, 5)).toBe('forty-two');
    expect(formatSearXngReply({ infoboxes: [{ content: '<p>Paris is <b>big</b></p>' }] }, 5)).toBe(
      'Paris is big',
    );
    expect(formatSearXngReply({ suggestions: ['a', 'b'] }, 5)).toBe('Suggestions: a, b');
    expect(formatSearXngReply({ results: [], answers: [], infoboxes: [], suggestions: [] }, 5)).toBe(
      'No good results found.',
    );
    expect(formatSearXngReply('garbage', 5)).toBe('No good results found.');
  });

  it('reaches the infobox, suggestion and no-result forms through the tool', async () => {
    const bodies: unknown[] = [
      { infoboxes: [{ content: '<i>Hi</i> there' }] },
      { suggestions: ['one'] },
      {},
    ];
    for (const [i, expected] of ['Hi there', 'Suggestions: one', 'No good results found.'].entries()) {
      const { observation } = await ask(
        searx(),
        { query: 'q' },
        services({ http: fake(() => ({ body: bodies[i] })), creds }),
      );
      expect(observation).toBe(expected);
    }
  });

  it('refuses a private SearXNG URL on the real HttpClient', async () => {
    for (const apiUrl of ['http://10.1.2.3:8080', 'http://127.0.0.1:9', 'http://169.254.169.254']) {
      const { observation } = await ask(
        searx(),
        { query: 'q' },
        services({ http: new HttpClient(), creds: { searXngApi: { apiUrl } } }),
      );
      expect(observation).toMatch(/^Error: .*blocked/);
    }
  });

  it('reaches an allow-listed local instance', async () => {
    const seen: Array<{ method?: string; url?: string }> = [];
    const server = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [{ title: 'L', url: 'https://l.example', content: 'local' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const { observation } = await ask(
        searx(),
        { query: 'hello world' },
        services({ http: new HttpClient({ ssrf: { allow: ['127.0.0.1'] } }), creds: { searXngApi: { apiUrl } } }),
      );
      expect(seen[0].method).toBe('POST');
      expect(seen[0].url).toBe('/search?q=hello+world&format=json&pageno=1&safesearch=0&language=en');
      expect(observation).toContain('"title":"L"');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('Wikipedia tool', () => {
  const wiki = () => node('Wiki', 'ai.toolWikipedia');
  const handler: FakeHandler = (request) => {
    const qs = request.qs as Record<string, unknown>;
    if (qs.list === 'search') {
      return {
        body: {
          query: { search: ['Alan Turing', 'Turing machine', 'Turing test', 'Fourth'].map((title) => ({ title })) },
        },
      };
    }
    const title = String(qs.titles);
    const extract = title === 'Alan Turing' ? 'T'.repeat(5000) : title === 'Turing test' ? '' : `About ${title}`;
    return { body: { query: { pages: { '1': { title, extract } } } } };
  };

  it('answers a recorded query: top 3 results, 4000 characters, empty pages skipped', async () => {
    const client = fake(handler);
    const { observation } = await ask(wiki(), { query: 'Turing' }, services({ http: client }));
    expect(client.requests).toHaveLength(4);
    const first = client.requests[0];
    expect(client.requests.every((q) => q.url === 'https://en.wikipedia.org/w/api.php')).toBe(true);
    expect(first.qs).toMatchObject({ list: 'search', srsearch: 'Turing', srlimit: 3 });
    expect(client.requests.slice(1).map((q) => (q.qs as any).titles)).toEqual([
      'Alan Turing',
      'Turing machine',
      'Turing test',
    ]);
    expect(observation).toBe(`Page: Alan Turing\nSummary: ${'T'.repeat(4000)}\n\nPage: Turing machine\nSummary: About Turing machine`);
  });

  it('says so when nothing is found', async () => {
    const client = fake(() => ({ body: { query: { search: [] } } }));
    const { observation } = await ask(wiki(), { query: 'zzzz' }, services({ http: client }));
    expect(observation).toBe('No good Wikipedia Search Result was found');
    const blank = fake(() => ({ body: {} }));
    expect((await ask(wiki(), { query: '  ' }, services({ http: blank }))).observation).toBe(
      'No good Wikipedia Search Result was found',
    );
    expect(blank.requests).toHaveLength(0);
  });
});

describe('Wolfram|Alpha tool', () => {
  const wolfram = () =>
    node('Wolfram', 'ai.toolWolframAlpha', {}, { credentials: { wolframAlphaApi: { id: 'c', name: 'w' } } });
  const APP_ID = 'APPID-SECRET-123';

  it('answers a recorded query with the App ID in a header only', async () => {
    const client = fake(() => ({ body: 'Query:\n"1+1"\n\nResult:\n2' }));
    const { r, requests, observation } = await ask(
      wolfram(),
      { query: '1+1' },
      services({ http: client, creds: { wolframAlphaApi: { appId: APP_ID } } }),
    );
    expect(r.status).toBe('success');
    expect(requests[0].tools?.[0].name).toBe('Wolfram');
    expect(client.requests).toHaveLength(1);
    const sent = client.requests[0];
    expect(sent.url).toBe('https://www.wolframalpha.com/api/v1/llm-api');
    expect(sent.qs).toEqual({ input: '1+1' });
    expect(sent.headers?.authorization).toBe(`Bearer ${APP_ID}`);
    expect(JSON.stringify({ url: sent.url, qs: sent.qs })).not.toContain(APP_ID);
    expect(observation).toBe('Query:\n"1+1"\n\nResult:\n2');
  });

  it('reports an error to the model without the App ID', async () => {
    const client = fake(() => ({ status: 403, body: 'Invalid appid' }));
    const { observation } = await ask(
      wolfram(),
      { query: 'x' },
      services({ http: client, creds: { wolframAlphaApi: { appId: APP_ID } } }),
    );
    expect(observation).toMatch(/^Error: /);
    expect(observation).not.toContain(APP_ID);
  });
});
