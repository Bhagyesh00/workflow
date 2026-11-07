/**
 * P5-33 Google Gemini node: one recorded call per operation on FakeHttpClient (bodies written from the
 * Gemini API docs), a tool turn, Veo pending then done, the resumable upload headers, and no key to a host
 * other than the credential's.
 */
import { NodeTypes } from '@workflow/core';
import type { AiTool, DataObject, Item, LoadOptionsContext, NodeType } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodes } from '../src';
import { GoogleGeminiNode } from '../src/nodes/vendors/gemini/GoogleGemini.node';
import { replyImages, replyText } from '../src/nodes/vendors/gemini/media';
import { geminiListSearch, pollTiming } from '../src/nodes/vendors/gemini/operations';
import {
  connect,
  type FakeHandler,
  FakeHttpClient,
  type FakeReply,
  type Link,
  node,
  run,
  services,
  testNodes,
} from './harness';

const KEY = 'AIzaSyTESTKEY0123456789abcdefghijklmnop';
const HOST = 'https://gemini.test';
const BASE = `${HOST}/v1beta`;

const calls: DataObject[] = [];
const toolNode: NodeType = {
  description: {
    name: 'test.geminiLookup',
    displayName: 'Lookup',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Lookup' },
    inputs: [],
    outputs: ['ai_tool'],
    properties: [],
  },
  async supplyData() {
    const tool: AiTool = {
      kind: 'tool',
      name: 'lookup',
      description: 'Looks a value up',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      invoke: async (args) => {
        calls.push(args);
        return `found ${String(args.q)}`;
      },
    };
    return { response: tool };
  },
};
const types = new NodeTypes([...nodes, ...testNodes, toolNode]);

const reply = (text: string, extra: DataObject = {}) => ({
  body: {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
    ...extra,
  },
});

const b64 = (text: string) => Buffer.from(text).toString('base64');

const bin = (text: string, mimeType: string, fileName?: string) => ({
  data: b64(text),
  mimeType,
  fileName,
  fileSize: text.length,
});

async function gem(
  params: DataObject,
  options: {
    handler?: FakeHandler;
    items?: Item[];
    tool?: boolean;
    onError?: 'continueRegularOutput';
    creds?: DataObject;
  } = {},
) {
  const fake = new FakeHttpClient(options.handler ?? (() => reply('ok')));
  const links: Link[] = [['Trigger', 'Gemini']];
  if (options.tool) links.push(['Tool', 'Gemini', 'ai_tool']);
  const result = await run(
    [
      node('Trigger', 'test.trigger'),
      node('Gemini', 'ai.googleGemini', params, {
        credentials: { googleGeminiApi: { id: 'c', name: 'c' } },
        ...(options.onError ? { onError: options.onError } : {}),
      }),
      ...(options.tool ? [node('Tool', 'test.geminiLookup')] : []),
    ],
    connect(...links),
    {
      nodeTypes: types,
      triggerItems: options.items,
      services: services({
        nodeTypes: types,
        creds: { googleGeminiApi: { apiKey: KEY, host: HOST, ...(options.creds ?? {}) } },
        http: fake,
      }),
    },
  );
  const runs = result.runData.Gemini ?? [];
  const items = (runs[runs.length - 1]?.data?.main?.[0] ?? []) as Item[];
  return { result, fake, out: result.output('Gemini'), items };
}

/** a candidate as the API gives it, which Simplify Output on returns as one item */
const candidate = (text: string) => ({ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' });

const msg = (content: string, extra: DataObject = {}) => ({
  messages: { values: [{ role: 'user', content, ...extra }] },
});

beforeEach(() => {
  calls.length = 0;
  pollTiming.videoIntervalMs = 5;
  pollTiming.importIntervalMs = 5;
  pollTiming.fileIntervalMs = 5;
});
afterEach(() => {
  pollTiming.videoIntervalMs = 5000;
  pollTiming.importIntervalMs = 3000;
  pollTiming.fileIntervalMs = 2000;
});

describe('node shape', () => {
  it('has the resources, the Tools input only for Message a Model, and the pickers', () => {
    const description = GoogleGeminiNode.description;
    expect(description.name).toBe('ai.googleGemini');
    expect(description.credentials?.[0]?.name).toBe('googleGeminiApi');
    const resource = description.properties.find((p) => p.name === 'resource') as any;
    expect(resource.options.map((o: any) => o.value)).toEqual([
      'text',
      'image',
      'audio',
      'video',
      'document',
      'file',
      'fileSearch',
    ]);
    const inputs = String(description.inputs).slice(3, -2);
    const evaluate = (resource: string, operation: string) =>
      new Function('$parameter', `return ${inputs}`)({ resource, operation }) as unknown[];
    expect(evaluate('text', 'message')).toHaveLength(2);
    expect(evaluate('image', 'analyze')).toEqual(['main']);
    expect(Object.keys(GoogleGeminiNode.methods?.listSearch ?? {}).sort()).toEqual([
      'imageEditModels',
      'imageModels',
      'textModels',
      'videoModels',
    ]);
  });

  it('lists models by what they can do', async () => {
    const ctx = {
      getCredentials: async () => ({ apiKey: KEY, host: HOST }),
      helpers: {
        httpRequestWithAuthentication: async () => ({
          models: [
            {
              name: 'models/gemini-2.5-flash',
              displayName: 'Gemini 2.5 Flash',
              supportedGenerationMethods: ['generateContent'],
            },
            { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/imagen-4.0-generate-001', supportedGenerationMethods: ['predict'] },
            { name: 'models/veo-3.0-generate-001', supportedGenerationMethods: ['predictLongRunning'] },
            { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          ],
        }),
      },
    } as unknown as LoadOptionsContext;
    const values = async (method: string, filter?: string) =>
      (await geminiListSearch[method]!(ctx, filter)).results.map((r) => r.value);
    expect(await values('textModels')).toEqual(['gemini-2.5-flash']);
    expect(await values('textModels', 'FLASH')).toEqual(['gemini-2.5-flash']);
    expect(await values('textModels', 'nothing')).toEqual([]);
    expect(await values('imageEditModels')).toEqual(['gemini-2.5-flash-image']);
    expect(await values('imageModels')).toEqual(['imagen-4.0-generate-001']);
    expect(await values('videoModels')).toEqual(['veo-3.0-generate-001']);
  });
});

describe('text.message', () => {
  it('sends the model call with the key, the options and the built-in tools', async () => {
    const { fake, out } = await gem({
      resource: 'text',
      operation: 'message',
      modelId: { __rl: true, mode: 'list', value: 'models/gemini-2.5-pro' },
      messages: {
        values: [
          { role: 'user', content: 'first' },
          { role: 'model', content: 'second' },
          { role: 'user', content: 'third' },
        ],
      },
      builtInTools: {
        googleSearch: true,
        googleMaps: true,
        mapsLatitude: '48.85',
        mapsLongitude: '2.35',
        urlContext: true,
        codeExecution: true,
        fileSearchStores: 'my-store, fileSearchStores/other',
        fileSearchFilter: 'author="Ada"',
      },
      options: {
        systemMessage: 'be brief',
        temperature: 0.4,
        topP: 0.9,
        topK: 20,
        maxOutputTokens: 256,
        thinkingBudget: 128,
        frequencyPenalty: 0.5,
        presencePenalty: -0.5,
        candidateCount: 2,
      },
    });
    expect(out).toEqual([candidate('ok')]);
    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0]!;
    expect(req.url).toBe(`${BASE}/models/gemini-2.5-pro:generateContent`);
    expect(req.headers?.['x-goog-api-key']).toBe(KEY);
    expect(JSON.stringify(req.qs ?? {})).not.toContain(KEY);
    expect(req.url).not.toContain(KEY);
    const body = req.body as any;
    expect(body.contents.map((c: any) => [c.role, c.parts[0].text])).toEqual([
      ['user', 'first'],
      ['model', 'second'],
      ['user', 'third'],
    ]);
    expect(body.systemInstruction.parts[0].text).toBe('be brief');
    expect(body.tools).toEqual([
      { googleSearch: {} },
      { googleMaps: {} },
      { urlContext: {} },
      { codeExecution: {} },
      {
        fileSearch: {
          fileSearchStoreNames: ['fileSearchStores/my-store', 'fileSearchStores/other'],
          metadataFilter: 'author="Ada"',
        },
      },
    ]);
    expect(body.toolConfig).toEqual({ retrievalConfig: { latLng: { latitude: 48.85, longitude: 2.35 } } });
    expect(body.generationConfig).toMatchObject({
      temperature: 0.4,
      topP: 0.9,
      topK: 20,
      maxOutputTokens: 256,
      thinkingConfig: { thinkingBudget: 128 },
      frequencyPenalty: 0.5,
      presencePenalty: -0.5,
      candidateCount: 2,
    });
    expect(body.generationConfig.responseMimeType).toBeUndefined();
  });

  it('asks for JSON and leaves the answer in the candidate as n8n does', async () => {
    const { fake, out } = await gem(
      { resource: 'text', operation: 'message', ...msg('list'), jsonOutput: true },
      { handler: () => reply('{"a":1,"b":[2]}') },
    );
    expect((fake.requests[0]!.body as any).generationConfig.responseMimeType).toBe('application/json');
    expect(out).toEqual([candidate('{"a":1,"b":[2]}')]);
  });

  it('does not parse the answer, so text that is not JSON is not an error', async () => {
    const { result, out } = await gem(
      { resource: 'text', operation: 'message', ...msg('list'), jsonOutput: true },
      { handler: () => reply('not json') },
    );
    expect(result.status).toBe('success');
    expect(out).toEqual([candidate('not json')]);
  });

  it('gives one item per candidate with Simplify on, the merged text inside each candidate', async () => {
    const two = {
      body: {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'a' }, { text: 'b' }] },
            finishReason: 'STOP',
            index: 0,
          },
          { content: { role: 'model', parts: [{ text: 'c' }] }, finishReason: 'STOP', index: 1 },
        ],
        usageMetadata: { promptTokenCount: 4 },
      },
    };
    const plain = await gem(
      { resource: 'text', operation: 'message', ...msg('hi'), options: { candidateCount: 2 } },
      { handler: () => two },
    );
    expect(plain.out).toHaveLength(2);
    expect(plain.out[0]).toEqual(two.body.candidates[0]);
    expect((plain.out[0] as any).mergedResponse).toBeUndefined();
    expect(plain.out[0]).not.toHaveProperty('usageMetadata');
    const merged = await gem(
      { resource: 'text', operation: 'message', ...msg('hi'), options: { includeMergedResponse: true } },
      { handler: () => two },
    );
    expect(merged.out.map((o) => (o as any).mergedResponse)).toEqual(['ab', 'c']);
    expect(merged.out[0]).toMatchObject({
      finishReason: 'STOP',
      content: { parts: [{ text: 'a' }, { text: 'b' }] },
    });
  });

  it('returns the whole reply with the merged text inside each candidate when Simplify is off', async () => {
    const { out } = await gem(
      {
        resource: 'text',
        operation: 'message',
        ...msg('hi'),
        simplify: false,
        options: { includeMergedResponse: true },
      },
      { handler: () => reply('hello') },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ usageMetadata: { promptTokenCount: 4 } });
    expect((out[0] as any).mergedResponse).toBeUndefined();
    expect((out[0] as any).candidates[0].mergedResponse).toBe('hello');
    expect((out[0] as any).candidates[0].content.parts[0].text).toBe('hello');
    const plain = await gem(
      { resource: 'text', operation: 'message', ...msg('hi'), simplify: false },
      { handler: () => reply('hello') },
    );
    expect(plain.out[0]).toEqual({
      candidates: [candidate('hello')],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
    });
  });

  it('runs a connected tool and sends its result back', async () => {
    const { fake, out } = await gem(
      { resource: 'text', operation: 'message', ...msg('look up x') },
      {
        tool: true,
        handler: (_req, index) =>
          index === 0
            ? {
                body: {
                  candidates: [
                    {
                      content: {
                        role: 'model',
                        parts: [{ functionCall: { name: 'lookup', args: { q: 'x' } } }],
                      },
                      finishReason: 'STOP',
                    },
                  ],
                },
              }
            : reply('it is found x'),
      },
    );
    expect(out).toEqual([candidate('it is found x')]);
    expect(calls).toEqual([{ q: 'x' }]);
    expect(fake.requests).toHaveLength(2);
    const first = fake.requests[0]!.body as any;
    expect(first.tools[0].functionDeclarations[0].name).toBe('lookup');
    const second = fake.requests[1]!.body as any;
    const last = second.contents[second.contents.length - 1];
    expect(last.parts[0].functionResponse.name).toBe('lookup');
    expect(last.parts[0].functionResponse.response).toEqual({ result: 'found x' });
  });

  it('reads attachments from a link and a binary field', async () => {
    const { fake } = await gem(
      {
        resource: 'text',
        operation: 'message',
        ...msg('see', { attachmentUrls: 'http://files.test/a.png', attachmentFields: 'doc' }),
      },
      {
        items: [{ json: {}, binary: { doc: bin('PDF', 'application/pdf', 'd.pdf') } }],
        handler: (req) =>
          req.url.startsWith('http://files.test')
            ? { body: Buffer.from('PNG'), headers: { 'content-type': 'image/png' } }
            : reply('seen'),
      },
    );
    const gemini = fake.requests.find((r) => r.url.includes(':generateContent'))!;
    const parts = (gemini.body as any).contents[0].parts;
    expect(parts[0]).toEqual({ text: 'see' });
    expect(parts.map((p: any) => p.inlineData?.mimeType)).toEqual([
      undefined,
      'image/png',
      'application/pdf',
    ]);
    // the file link got no key
    const download = fake.requests.find((r) => r.url.startsWith('http://files.test'))!;
    expect(JSON.stringify(download.headers ?? {})).not.toContain(KEY);
  });

  it('refuses a tool that waits before any request', async () => {
    const waiting: NodeType = {
      ...toolNode,
      description: { ...toolNode.description, name: 'test.geminiWait' },
      async supplyData(...args) {
        const made = await toolNode.supplyData!(...args);
        return { response: { ...(made.response as AiTool), canWait: true } };
      },
    };
    const withWait = new NodeTypes([...nodes, ...testNodes, waiting]);
    const fake = new FakeHttpClient(() => reply('x'));
    const result = await run(
      [
        node('Trigger', 'test.trigger'),
        node(
          'Gemini',
          'ai.googleGemini',
          { resource: 'text', operation: 'message', ...msg('hi') },
          {
            credentials: { googleGeminiApi: { id: 'c', name: 'c' } },
          },
        ),
        node('Tool', 'test.geminiWait'),
      ],
      connect(['Trigger', 'Gemini'], ['Tool', 'Gemini', 'ai_tool']),
      {
        nodeTypes: withWait,
        services: services({
          nodeTypes: withWait,
          creds: { googleGeminiApi: { apiKey: KEY, host: HOST } },
          http: fake,
        }),
      },
    );
    expect(result.status).toBe('error');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('reply helpers', () => {
  it('read a reply of any shape without throwing', () => {
    for (const body of [
      null,
      'x',
      {},
      { candidates: 'x' },
      { candidates: [{ content: { parts: 'oops' } }] },
    ]) {
      expect(replyText(body)).toBe('');
      expect(replyImages(body)).toEqual([]);
    }
    const body = {
      candidates: [
        {
          content: {
            parts: [{ text: 'hi ' }, { text: 'thought', thought: true }, { text: 'there' }],
          },
        },
      ],
    };
    expect(replyText(body)).toBe('hi there');
  });
});

describe('analyze operations', () => {
  it('shows why when a prompt is blocked and no candidate comes back', async () => {
    const blocked = { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 3 } };
    const { out } = await gem(
      {
        resource: 'image',
        operation: 'analyze',
        prompt: 'p',
        inputType: 'binary',
        binaryPropertyName: 'data',
      },
      { items: [{ json: {}, binary: { data: bin('A', 'image/png') } }], handler: () => ({ body: blocked }) },
    );
    expect(out).toEqual([blocked]);
  });

  it('image.analyze sends the images inline with the prompt and the 300 token default', async () => {
    const { fake, out } = await gem(
      {
        resource: 'image',
        operation: 'analyze',
        modelId: 'gemini-2.5-flash',
        prompt: 'what is this',
        inputType: 'binary',
        binaryPropertyName: 'data, other',
        options: { maxOutputTokens: 300 },
      },
      {
        items: [{ json: {}, binary: { data: bin('AAA', 'image/png'), other: bin('BBB', 'image/jpeg') } }],
        handler: () => reply('a cat'),
      },
    );
    expect(out[0]).toEqual(candidate('a cat'));
    const req = fake.requests[0]!;
    expect(req.url).toBe(`${BASE}/models/gemini-2.5-flash:generateContent`);
    const body = req.body as any;
    expect(body.contents[0].parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: b64('AAA') } },
      { inlineData: { mimeType: 'image/jpeg', data: b64('BBB') } },
      { text: 'what is this' },
    ]);
    expect(body.generationConfig).toEqual({ maxOutputTokens: 300 });
  });

  it('image.analyze reads a link and returns the raw reply with Simplify off', async () => {
    const { out, fake } = await gem(
      {
        resource: 'image',
        operation: 'analyze',
        prompt: 'p',
        inputType: 'url',
        url: 'http://files.test/x.png',
        simplify: false,
      },
      {
        handler: (req) =>
          req.url.startsWith('http://files.test')
            ? { body: Buffer.from('IMG'), headers: { 'content-type': 'image/png' } }
            : reply('desc'),
      },
    );
    expect((out[0] as any).candidates[0].content.parts[0].text).toBe('desc');
    expect((fake.requests[1]!.body as any).contents[0].parts[0].inlineData.data).toBe(b64('IMG'));
  });

  it('rejects a file of the wrong kind', async () => {
    const { result, fake } = await gem(
      {
        resource: 'image',
        operation: 'analyze',
        prompt: 'p',
        inputType: 'binary',
        binaryPropertyName: 'data',
      },
      { items: [{ json: {}, binary: { data: bin('x', 'audio/mpeg') } }] },
    );
    expect(result.status).toBe('error');
    expect(fake.requests).toHaveLength(0);
  });

  it('audio.transcribe names the time range', async () => {
    const { fake, out } = await gem(
      {
        resource: 'audio',
        operation: 'transcribe',
        inputType: 'binary',
        binaryPropertyName: 'data',
        options: { startTime: '00:10', endTime: '00:40' },
      },
      {
        items: [{ json: {}, binary: { data: bin('SND', 'audio/mpeg') } }],
        handler: () => reply('hello there'),
      },
    );
    expect(out[0]).toEqual(candidate('hello there'));
    const parts = (fake.requests[0]!.body as any).contents[0].parts;
    expect(parts[0].inlineData.mimeType).toBe('audio/mpeg');
    expect(parts[1].text).toContain('from 00:10 to 00:40');
  });

  it('audio.analyze and document.analyze send their file and prompt', async () => {
    const audio = await gem(
      {
        resource: 'audio',
        operation: 'analyze',
        prompt: 'mood?',
        inputType: 'binary',
        binaryPropertyName: 'data',
      },
      { items: [{ json: {}, binary: { data: bin('SND', 'audio/wav') } }], handler: () => reply('calm') },
    );
    expect(audio.out[0]).toEqual(candidate('calm'));
    expect((audio.fake.requests[0]!.body as any).contents[0].parts[1].text).toBe('mood?');
    const doc = await gem(
      {
        resource: 'document',
        operation: 'analyze',
        prompt: 'sum',
        inputType: 'binary',
        binaryPropertyName: 'data',
      },
      {
        items: [{ json: {}, binary: { data: bin('PDF', 'application/pdf', 'a.pdf') } }],
        handler: () => reply('short'),
      },
    );
    expect(doc.out[0]).toEqual(candidate('short'));
    expect((doc.fake.requests[0]!.body as any).contents[0].parts[0].inlineData.mimeType).toBe(
      'application/pdf',
    );
  });

  it('video.analyze passes a YouTube link as a file reference', async () => {
    const { fake, out } = await gem(
      {
        resource: 'video',
        operation: 'analyze',
        prompt: 'what happens',
        inputType: 'url',
        url: 'https://www.youtube.com/watch?v=abc',
      },
      { handler: () => reply('a dance') },
    );
    expect(out[0]).toEqual(candidate('a dance'));
    expect(fake.requests).toHaveLength(1);
    expect((fake.requests[0]!.body as any).contents[0].parts[0]).toEqual({
      fileData: { fileUri: 'https://www.youtube.com/watch?v=abc' },
    });
  });

  it('video.analyze uploads a large file first and waits until it is active', async () => {
    const big = Buffer.alloc(19 * 1024 * 1024, 1);
    const item: Item = {
      json: {},
      binary: {
        data: {
          data: big.toString('base64'),
          mimeType: 'video/mp4',
          fileName: 'v.mp4',
          fileSize: big.length,
        },
      },
    };
    const { fake, out } = await gem(
      {
        resource: 'video',
        operation: 'analyze',
        prompt: 'p',
        inputType: 'binary',
        binaryPropertyName: 'data',
      },
      {
        items: [item],
        handler: (req) => {
          if (req.url === `${HOST}/upload/v1beta/files`) {
            return { headers: { 'x-goog-upload-url': `${HOST}/upload/session/s1` }, body: {} };
          }
          if (req.url === `${HOST}/upload/session/s1`) {
            return {
              body: {
                file: {
                  name: 'files/f1',
                  uri: `${HOST}/v1beta/files/f1`,
                  mimeType: 'video/mp4',
                  state: 'PROCESSING',
                },
              },
            };
          }
          if (req.url === `${BASE}/files/f1`)
            return {
              body: {
                name: 'files/f1',
                uri: `${HOST}/v1beta/files/f1`,
                mimeType: 'video/mp4',
                state: 'ACTIVE',
              },
            };
          return reply('a long film');
        },
      },
    );
    expect(out[0]).toEqual(candidate('a long film'));
    const last = fake.requests[fake.requests.length - 1]!;
    expect((last.body as any).contents[0].parts[0]).toEqual({
      fileData: { mimeType: 'video/mp4', fileUri: `${HOST}/v1beta/files/f1` },
    });
  });
});

describe('image generate and edit', () => {
  it('image.generate calls predict and returns one binary item per picture', async () => {
    const { fake, items } = await gem(
      {
        resource: 'image',
        operation: 'generate',
        modelId: 'imagen-4.0-generate-001',
        prompt: 'a lighthouse',
        options: { numberOfImages: 2, binaryPropertyOutput: 'pic' },
      },
      {
        handler: () => ({
          body: {
            predictions: [
              { bytesBase64Encoded: b64('ONE'), mimeType: 'image/png' },
              { bytesBase64Encoded: b64('TWO'), mimeType: 'image/png' },
            ],
          },
        }),
      },
    );
    const req = fake.requests[0]!;
    expect(req.url).toBe(`${BASE}/models/imagen-4.0-generate-001:predict`);
    expect(req.body).toEqual({ instances: [{ prompt: 'a lighthouse' }], parameters: { sampleCount: 2 } });
    expect(items).toHaveLength(2);
    expect(items[0]!.binary?.pic?.mimeType).toBe('image/png');
    // n8n puts the details of the file in json, without the data
    expect(items[0]!.json).toMatchObject({ mimeType: 'image/png', fileName: 'image.png' });
    expect(items[0]!.json).not.toHaveProperty('data');
    expect(items[1]!.pairedItem).toEqual({ item: 0 });
  });

  it('image.generate fails with a clear text when nothing comes back', async () => {
    const { result } = await gem(
      { resource: 'image', operation: 'generate', prompt: 'x' },
      { handler: () => ({ body: { predictions: [] } }) },
    );
    expect(result.status).toBe('error');
    expect(JSON.stringify(result.error)).toContain('no image');
  });

  it('image.edit sends the prompt and images and returns the picture', async () => {
    const { fake, items } = await gem(
      { resource: 'image', operation: 'edit', prompt: 'purple sky', images: 'data' },
      {
        items: [{ json: {}, binary: { data: bin('SRC', 'image/png') } }],
        handler: () => ({
          body: {
            candidates: [
              {
                content: {
                  parts: [{ text: 'done' }, { inlineData: { mimeType: 'image/png', data: b64('EDIT') } }],
                },
              },
            ],
          },
        }),
      },
    );
    const req = fake.requests[0]!;
    expect(req.url).toBe(`${BASE}/models/gemini-2.5-flash-image:generateContent`);
    const body = req.body as any;
    expect(body.contents[0].parts).toEqual([
      { text: 'purple sky' },
      { inlineData: { mimeType: 'image/png', data: b64('SRC') } },
    ]);
    expect(body.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE']);
    expect(items[0]!.binary?.edited).toBeTruthy();
    // the details of the file, not the data, as n8n gives them
    expect(items[0]!.json).toMatchObject({ mimeType: 'image/png', fileName: 'edited.png' });
    expect(items[0]!.json).not.toHaveProperty('data');
  });
});

describe('video generate and download', () => {
  const veo =
    (uri: string): FakeHandler =>
    (req, index) => {
      if (req.url.endsWith(':predictLongRunning'))
        return { body: { name: 'models/veo-3.0-generate-001/operations/op1' } };
      if (req.url === `${BASE}/models/veo-3.0-generate-001/operations/op1`) {
        return index < 3
          ? { body: { name: 'models/veo-3.0-generate-001/operations/op1', done: false } }
          : {
              body: {
                name: 'models/veo-3.0-generate-001/operations/op1',
                done: true,
                response: { generateVideoResponse: { generatedSamples: [{ video: { uri } }] } },
              },
            };
      }
      return { body: Buffer.from('MP4DATA'), headers: { 'content-type': 'video/mp4' } };
    };

  it('polls pending then done, then downloads the video with the key on the credential host', async () => {
    const { fake, items } = await gem(
      {
        resource: 'video',
        operation: 'generate',
        modelId: 'veo-3.0-generate-001',
        prompt: 'a paper boat',
        options: { durationSeconds: 6, aspectRatio: '9:16', sampleCount: 1, personGeneration: 'dont_allow' },
      },
      { handler: veo(`${BASE}/files/vid1:download?alt=media`) },
    );
    const start = fake.requests[0]!;
    expect(start.url).toBe(`${BASE}/models/veo-3.0-generate-001:predictLongRunning`);
    expect(start.body).toEqual({
      instances: [{ prompt: 'a paper boat' }],
      parameters: { sampleCount: 1, durationSeconds: 6, aspectRatio: '9:16', personGeneration: 'dont_allow' },
    });
    const polls = fake.requests.filter((r) => r.url.endsWith('/operations/op1'));
    expect(polls).toHaveLength(3);
    const download = fake.requests[fake.requests.length - 1]!;
    expect(download.headers?.['x-goog-api-key']).toBe(KEY);
    expect(download.followRedirects).toBe(false);
    expect(items[0]!.binary?.data?.mimeType).toBe('video/mp4');
    expect(items[0]!.json).toMatchObject({ mimeType: 'video/mp4' });
    expect(items[0]!.json).not.toHaveProperty('data');
  });

  it('returns only the link when asked', async () => {
    const { fake, out } = await gem(
      { resource: 'video', operation: 'generate', prompt: 'p', options: { returnAs: 'url' } },
      { handler: veo(`${BASE}/files/vid1:download?alt=media`) },
    );
    expect(out[0]).toEqual({ url: `${BASE}/files/vid1:download?alt=media` });
    expect(fake.requests.some((r) => r.url.includes(':download'))).toBe(false);
  });

  it('sends no key to a video link on another host', async () => {
    const { fake, items } = await gem(
      { resource: 'video', operation: 'download', url: 'http://cdn.other.test/v.mp4' },
      { handler: () => ({ body: Buffer.from('MP4'), headers: { 'content-type': 'video/mp4' } }) },
    );
    expect(fake.requests).toHaveLength(1);
    expect(JSON.stringify(fake.requests[0]!.headers ?? {})).not.toContain(KEY);
    expect(fake.requests[0]!.url).toBe('http://cdn.other.test/v.mp4');
    expect(items[0]!.binary?.data).toBeTruthy();
  });

  it('downloads a link on the credential host with the key and without following redirects', async () => {
    const { fake } = await gem(
      {
        resource: 'video',
        operation: 'download',
        url: `${BASE}/files/v:download?alt=media`,
        options: { binaryPropertyOutput: 'clip' },
      },
      { handler: () => ({ body: Buffer.from('MP4'), headers: { 'content-type': 'video/mp4' } }) },
    );
    expect(fake.requests[0]!.headers?.['x-goog-api-key']).toBe(KEY);
    expect(fake.requests[0]!.followRedirects).toBe(false);
  });

  it('a generated link that redirects to another host is fetched there without the key', async () => {
    const { fake } = await gem(
      { resource: 'video', operation: 'download', url: `${BASE}/files/v:download?alt=media` },
      {
        handler: (req): FakeReply =>
          req.url.startsWith(HOST)
            ? { status: 302, headers: { location: 'http://storage.other.test/v.mp4' }, body: '' }
            : { body: Buffer.from('MP4'), headers: { 'content-type': 'video/mp4' } },
      },
    );
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.url).toBe('http://storage.other.test/v.mp4');
    expect(JSON.stringify(fake.requests[1]!.headers ?? {})).not.toContain(KEY);
  });

  it('shows the reason when the video was filtered', async () => {
    const { result } = await gem(
      { resource: 'video', operation: 'generate', prompt: 'p' },
      {
        handler: (req) =>
          req.url.endsWith(':predictLongRunning')
            ? {
                body: {
                  name: 'models/veo/operations/o',
                  done: true,
                  response: { generateVideoResponse: { raiMediaFilteredReasons: ['blocked by policy'] } },
                },
              }
            : reply('x'),
      },
    );
    expect(result.status).toBe('error');
    expect(JSON.stringify(result.error)).toContain('no video');
  });

  it('turns an error inside the job into the node error, without the key', async () => {
    const { result } = await gem(
      { resource: 'video', operation: 'generate', prompt: 'p' },
      {
        handler: () => ({
          body: {
            name: 'models/veo/operations/o',
            done: true,
            error: { message: `quota used up for key ${KEY}` },
          },
        }),
      },
    );
    expect(result.status).toBe('error');
    expect(JSON.stringify(result.error)).toContain('quota used up');
    expect(JSON.stringify(result.error)).not.toContain(KEY);
  });
});

describe('file upload (resumable)', () => {
  const upload =
    (
      sessionUrl: string,
      final: DataObject = {
        file: { name: 'files/f9', uri: `${BASE}/files/f9`, mimeType: 'application/pdf', state: 'ACTIVE' },
      },
    ): FakeHandler =>
    (req) => {
      if (req.url === `${HOST}/upload/v1beta/files`)
        return { headers: { 'x-goog-upload-url': sessionUrl }, body: {} };
      return { body: final };
    };
  const params = {
    resource: 'file',
    operation: 'upload',
    inputType: 'binary',
    binaryPropertyName: 'data',
    displayName: 'My PDF',
  };
  const items = [{ json: {}, binary: { data: bin('PDFBYTES', 'application/pdf', 'a.pdf') } }];

  it('starts the session, then uploads and finalizes on the address it gave', async () => {
    const { fake, out } = await gem(params, { items, handler: upload(`${HOST}/upload/session/abc`) });
    expect(out[0]).toMatchObject({ name: 'files/f9', uri: `${BASE}/files/f9` });
    expect(fake.requests).toHaveLength(2);
    const [start, finalize] = fake.requests as [any, any];
    expect(start.url).toBe(`${HOST}/upload/v1beta/files`);
    expect(start.method).toBe('POST');
    expect(start.headers).toMatchObject({
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': '8',
      'X-Goog-Upload-Header-Content-Type': 'application/pdf',
      'x-goog-api-key': KEY,
    });
    expect(start.body).toEqual({ file: { display_name: 'My PDF' } });
    expect(start.followRedirects).toBe(false);
    expect(finalize.url).toBe(`${HOST}/upload/session/abc`);
    expect(finalize.headers).toMatchObject({
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
      'x-goog-api-key': KEY,
    });
    expect(Buffer.from(finalize.body).toString()).toBe('PDFBYTES');
    expect(finalize.followRedirects).toBe(false);
  });

  it('sends no key to an upload address on another host', async () => {
    const { fake } = await gem(params, { items, handler: upload('http://upload.other.test/session/1') });
    const finalize = fake.requests[1]!;
    expect(finalize.url).toBe('http://upload.other.test/session/1');
    expect(JSON.stringify(finalize.headers ?? {})).not.toContain(KEY);
    expect(finalize.headers).toMatchObject({ 'X-Goog-Upload-Command': 'upload, finalize' });
    expect(finalize.followRedirects).toBe(false);
  });

  it('sends no key to a plain http upload address on the credential host', async () => {
    const plain = `http://${new URL(HOST).host}/upload/session/abc`;
    const { fake } = await gem(params, { items, handler: upload(plain) });
    const finalize = fake.requests[1]!;
    expect(finalize.url).toBe(plain);
    expect(JSON.stringify(finalize.headers ?? {})).not.toContain(KEY);
    expect(finalize.headers).toMatchObject({ 'X-Goog-Upload-Command': 'upload, finalize' });
  });

  it('treats a redirect on the start call as an error and sends no bytes', async () => {
    const { result, fake } = await gem(params, {
      items,
      handler: () => ({ status: 307, headers: { location: 'http://evil.test/x' }, body: '' }),
    });
    expect(result.status).toBe('error');
    expect(JSON.stringify(result.error)).toContain('redirected');
    expect(fake.requests).toHaveLength(1);
  });

  it('treats a redirect on the finalize call as an error', async () => {
    const { result, fake } = await gem(params, {
      items,
      handler: (req): FakeReply =>
        req.url === `${HOST}/upload/v1beta/files`
          ? { headers: { 'x-goog-upload-url': `${HOST}/upload/session/abc` }, body: {} }
          : { status: 302, headers: { location: 'http://evil.test/x' }, body: '' },
    });
    expect(result.status).toBe('error');
    expect(fake.requests).toHaveLength(2);
  });

  it('fails when no upload address comes back', async () => {
    const { result } = await gem(params, { items, handler: () => ({ body: {} }) });
    expect(result.status).toBe('error');
    expect(JSON.stringify(result.error)).toContain('upload address');
  });

  it('uploads a file given by link', async () => {
    const { fake } = await gem(
      { resource: 'file', operation: 'upload', inputType: 'url', url: 'http://files.test/r.pdf' },
      {
        handler: (req) =>
          req.url.startsWith('http://files.test')
            ? { body: Buffer.from('LINKED'), headers: { 'content-type': 'application/pdf' } }
            : upload(`${HOST}/upload/session/z`)(req, 0),
      },
    );
    expect(fake.requests[0]!.url).toBe('http://files.test/r.pdf');
    expect(JSON.stringify(fake.requests[0]!.headers ?? {})).not.toContain(KEY);
    expect((fake.requests[1]!.body as any).file.display_name).toBe('r.pdf');
  });
});

describe('file search stores', () => {
  it('createStore posts the display name', async () => {
    const { fake, out } = await gem(
      { resource: 'fileSearch', operation: 'createStore', storeDisplayName: 'Docs' },
      { handler: () => ({ body: { name: 'fileSearchStores/docs-1', displayName: 'Docs' } }) },
    );
    expect(fake.requests[0]).toMatchObject({
      url: `${BASE}/fileSearchStores`,
      method: 'POST',
      body: { displayName: 'Docs' },
    });
    expect(out[0]).toEqual({ name: 'fileSearchStores/docs-1', displayName: 'Docs' });
  });

  it('deleteStore sends force and the name', async () => {
    const { fake, out } = await gem(
      { resource: 'fileSearch', operation: 'deleteStore', storeName: 'docs-1', force: true },
      { handler: () => ({ body: '' }) },
    );
    expect(fake.requests[0]).toMatchObject({
      url: `${BASE}/fileSearchStores/docs-1`,
      method: 'DELETE',
      qs: { force: true },
    });
    expect(out[0]).toEqual({ success: true, name: 'fileSearchStores/docs-1' });
  });

  it('refuses a store name that could change the path', async () => {
    const { result, fake } = await gem(
      { resource: 'fileSearch', operation: 'deleteStore', storeName: '../models/x' },
      {},
    );
    expect(result.status).toBe('error');
    expect(fake.requests).toHaveLength(0);
  });

  it('listStores passes the page size and token', async () => {
    const { fake, out } = await gem(
      { resource: 'fileSearch', operation: 'listStores', pageSize: 5, pageToken: 'tok' },
      {
        handler: () => ({
          body: { fileSearchStores: [{ name: 'fileSearchStores/a' }], nextPageToken: 'n2' },
        }),
      },
    );
    expect(fake.requests[0]).toMatchObject({
      url: `${BASE}/fileSearchStores`,
      qs: { pageSize: 5, pageToken: 'tok' },
    });
    expect(out[0]).toEqual({ fileSearchStores: [{ name: 'fileSearchStores/a' }], nextPageToken: 'n2' });
  });

  it('uploadToStore uploads resumably, then waits for the import to finish', async () => {
    const { fake, out } = await gem(
      {
        resource: 'fileSearch',
        operation: 'uploadToStore',
        storeName: 'fileSearchStores/docs-1',
        fileDisplayName: 'Manual',
        inputType: 'binary',
        binaryPropertyName: 'data',
      },
      {
        items: [{ json: {}, binary: { data: bin('TEXT', 'text/plain', 'm.txt') } }],
        handler: (req, index) => {
          if (req.url === `${HOST}/upload/v1beta/fileSearchStores/docs-1:uploadToFileSearchStore`) {
            return { headers: { 'x-goog-upload-url': `${HOST}/upload/session/fs1` }, body: {} };
          }
          if (req.url === `${HOST}/upload/session/fs1`) {
            return { body: { name: 'fileSearchStores/docs-1/operations/imp1', done: false } };
          }
          return index < 4
            ? { body: { name: 'fileSearchStores/docs-1/operations/imp1', done: false } }
            : {
                body: {
                  name: 'fileSearchStores/docs-1/operations/imp1',
                  done: true,
                  response: { documentName: 'fileSearchStores/docs-1/documents/d1' },
                },
              };
        },
      },
    );
    const start = fake.requests[0] as any;
    expect(start.body).toEqual({ displayName: 'Manual', mimeType: 'text/plain' });
    expect(start.headers['X-Goog-Upload-Header-Content-Type']).toBe('text/plain');
    expect(fake.requests[1]!.url).toBe(`${HOST}/upload/session/fs1`);
    expect(
      fake.requests.filter((r) => r.url === `${BASE}/fileSearchStores/docs-1/operations/imp1`).length,
    ).toBeGreaterThanOrEqual(2);
    expect(out[0]).toMatchObject({
      done: true,
      store: 'fileSearchStores/docs-1',
      response: { documentName: 'fileSearchStores/docs-1/documents/d1' },
    });
  });

  it('refuses an operation name from the server that could change the path', async () => {
    const { result, fake } = await gem(
      {
        resource: 'fileSearch',
        operation: 'uploadToStore',
        storeName: 'docs-1',
        inputType: 'binary',
        binaryPropertyName: 'data',
      },
      {
        items: [{ json: {}, binary: { data: bin('T', 'text/plain', 't.txt') } }],
        handler: (req) =>
          req.url.includes(':uploadToFileSearchStore')
            ? { headers: { 'x-goog-upload-url': `${HOST}/upload/session/q` }, body: {} }
            : { body: { name: '../../etc/passwd', done: false } },
      },
    );
    expect(result.status).toBe('error');
    expect(fake.requests).toHaveLength(2);
  });
});

describe('errors', () => {
  it('a failed call becomes the node error with the key cut out', async () => {
    const { result } = await gem(
      { resource: 'text', operation: 'message', ...msg('hi') },
      {
        handler: () => ({
          status: 400,
          body: { error: { code: 400, message: `API key not valid: ${KEY}`, status: 'INVALID_ARGUMENT' } },
        }),
      },
    );
    expect(result.status).toBe('error');
    expect(JSON.stringify(result.error)).not.toContain(KEY);
  });

  it('continue on fail gives {error} per item', async () => {
    const { out } = await gem(
      { resource: 'fileSearch', operation: 'createStore', storeDisplayName: '' },
      { onError: 'continueRegularOutput' },
    );
    expect(String((out[0] as any).error)).toContain('display name');
  });
});
