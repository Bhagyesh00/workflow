/**
 * P5-36 MiniMax node: one recorded call per operation on FakeHttpClient (bodies written from the MiniMax
 * API docs), a tool turn, Hide Thinking, hex and link audio, the video create, poll and file retrieve, a
 * `base_resp` failure, and no credential header on the media host.
 */
import { NodeTypes } from '@workflow/core';
import type { AiTool, DataObject, Item, NodeType } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodes } from '../src';
import { MinimaxNode } from '../src/nodes/vendors/minimax/Minimax.node';
import { pollTiming } from '../src/nodes/vendors/minimax/video';
import {
  connect,
  type FakeHandler,
  FakeHttpClient,
  type Link,
  node,
  run,
  services,
  testNodes,
} from './harness';

const KEY = 'sk-minimaxtestkey0123456789abcdef';
const HOST = 'http://minimax.test/v1';
const MEDIA = 'http://media.test';

const calls: DataObject[] = [];
const toolNode: NodeType = {
  description: {
    name: 'test.minimaxLookup',
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

const ok = { status_code: 0, status_msg: 'success' };
const answer = (text: string) => ({
  body: {
    id: 'c1',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    base_resp: ok,
  },
});
const b64 = (text: string) => Buffer.from(text).toString('base64');
const bin = (text: string, mimeType: string, fileName?: string) => ({
  data: b64(text),
  mimeType,
  fileName,
  fileSize: text.length,
});

async function minimax(
  params: DataObject,
  options: { handler?: FakeHandler; items?: Item[]; tool?: boolean; onError?: 'continueRegularOutput' } = {},
) {
  const fake = new FakeHttpClient(options.handler ?? (() => answer('ok')));
  const links: Link[] = [['Trigger', 'Mini']];
  if (options.tool) links.push(['Tool', 'Mini', 'ai_tool']);
  const result = await run(
    [
      node('Trigger', 'test.trigger'),
      node('Mini', 'ai.minimax', params, {
        credentials: { minimaxApi: { id: 'c', name: 'c' } },
        ...(options.onError ? { onError: options.onError } : {}),
      }),
      ...(options.tool ? [node('Tool', 'test.minimaxLookup')] : []),
    ],
    connect(...links),
    {
      nodeTypes: types,
      triggerItems: options.items,
      services: services({
        nodeTypes: types,
        creds: { minimaxApi: { apiKey: KEY, url: HOST } },
        http: fake,
      }),
    },
  );
  const runs = result.runData.Mini ?? [];
  const items = (runs[runs.length - 1]?.data?.main?.[0] ?? []) as Item[];
  return { result, fake, out: result.output('Mini'), items };
}

const msg = (content: string) => ({ messages: { values: [{ role: 'user', content }] } });

const header = (request: { headers?: Record<string, unknown> }, name: string): unknown => {
  const found = Object.entries(request.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1];
};

beforeEach(() => {
  calls.length = 0;
  pollTiming.intervalMs = 5;
});
afterEach(() => {
  pollTiming.intervalMs = 10_000;
  pollTiming.timeoutMs = 20 * 60 * 1000;
});

describe('node shape', () => {
  it('has the four resources and the Tools input only for Message a Model', () => {
    const description = MinimaxNode.description;
    expect(description.name).toBe('ai.minimax');
    expect(description.credentials?.[0]?.name).toBe('minimaxApi');
    const resource = description.properties.find((p) => p.name === 'resource') as any;
    expect(resource.options.map((o: any) => o.value)).toEqual(['text', 'image', 'audio', 'video']);
    const inputs = String(description.inputs).slice(3, -2);
    const evaluate = (resource: string, operation: string) =>
      new Function('$parameter', `return ${inputs}`)({ resource, operation }) as unknown[];
    expect(evaluate('text', 'message')).toHaveLength(2);
    expect(evaluate('image', 'generate')).toEqual(['main']);
    expect(evaluate('audio', 'textToSpeech')).toEqual(['main']);
    expect(evaluate('video', 'imageToVideo')).toEqual(['main']);
  });
});

describe('text.message', () => {
  it('sends the chat call with the key, the options and Hide Thinking on by default', async () => {
    const { fake, out } = await minimax(
      {
        resource: 'text',
        operation: 'message',
        modelId: 'MiniMax-M3',
        messages: {
          values: [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'second' },
            { role: 'user', content: 'third' },
          ],
        },
        options: { systemMessage: 'be brief', temperature: 0.4, maxTokens: 50 },
      },
      { handler: () => answer('<think>hmm, let me see</think>\n\nhello') },
    );
    expect(out[0]).toEqual({ output: 'hello' });
    const req = fake.requests[0]!;
    expect(req.url).toBe(`${HOST}/chat/completions`);
    expect(req.method).toBe('POST');
    expect(header(req, 'authorization')).toBe(`Bearer ${KEY}`);
    const body = req.body as any;
    expect(body.model).toBe('MiniMax-M3');
    expect(body.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ]);
    expect(body.temperature).toBe(0.4);
    expect(body.max_tokens).toBe(50);
  });

  it('keeps the thinking with Hide Thinking off, and defaults Max Tokens to 1024', async () => {
    const { fake, out } = await minimax(
      { resource: 'text', operation: 'message', ...msg('hi'), options: { hideThinking: false } },
      { handler: () => answer('<think>idea</think>done') },
    );
    expect(out[0]).toEqual({ output: '<think>idea</think>done' });
    expect((fake.requests[0]!.body as any).max_tokens).toBe(1024);
  });

  it('cuts a thinking block that was never closed', async () => {
    const { out } = await minimax(
      { resource: 'text', operation: 'message', ...msg('hi') },
      { handler: () => answer('visible<think>cut off by the token limit') },
    );
    expect(out[0]).toEqual({ output: 'visible' });
  });

  it('returns the raw reply with Simplify off', async () => {
    const { out } = await minimax(
      { resource: 'text', operation: 'message', ...msg('hi'), simplify: false },
      { handler: () => answer('raw') },
    );
    expect((out[0] as any).id).toBe('c1');
    expect((out[0] as any).choices[0].message.content).toBe('raw');
  });

  it('runs a connected tool and sends its result back', async () => {
    let turn = 0;
    const { fake, out } = await minimax(
      { resource: 'text', operation: 'message', ...msg('look it up') },
      {
        tool: true,
        handler: () => {
          turn++;
          if (turn === 1) {
            return {
              body: {
                choices: [
                  {
                    finish_reason: 'tool_calls',
                    message: {
                      role: 'assistant',
                      content: '',
                      tool_calls: [
                        { id: 't1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
                      ],
                    },
                  },
                ],
                base_resp: ok,
              },
            };
          }
          return answer('it is found x');
        },
      },
    );
    expect(out[0]).toEqual({ output: 'it is found x' });
    expect(calls).toEqual([{ q: 'x' }]);
    expect(fake.requests).toHaveLength(2);
    expect(JSON.stringify((fake.requests[1]!.body as any).messages)).toContain('found x');
  });

  it('turns a base_resp failure on HTTP 200 into an error without the key', async () => {
    const { result } = await minimax(
      { resource: 'text', operation: 'message', ...msg('hi') },
      {
        handler: () => ({
          body: { base_resp: { status_code: 1004, status_msg: `login fail with ${KEY}` } },
        }),
      },
    );
    expect(result.status).toBe('error');
    const text = JSON.stringify(result.error);
    expect(text).toContain('1004');
    expect(text).not.toContain(KEY);
  });

  it('refuses without a message', async () => {
    const { result, fake } = await minimax({ resource: 'text', operation: 'message' });
    expect(result.status).toBe('error');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('image.generate', () => {
  const images = (urls: string[]) => ({
    body: { id: 'img-1', data: { image_urls: urls }, metadata: {}, base_resp: ok },
  });

  it('sends the call and downloads each image with no key', async () => {
    const { fake, items } = await minimax(
      {
        resource: 'image',
        operation: 'generate',
        prompt: 'a red fox',
        options: { aspectRatio: '16:9', n: 2, promptOptimizer: true, seed: 3 },
      },
      {
        handler: (req) =>
          req.url.startsWith(MEDIA)
            ? { body: Buffer.from('JPG' + req.url.slice(-5)), headers: { 'content-type': 'image/jpeg' } }
            : images([`${MEDIA}/a.jpg`, `${MEDIA}/b.jpg`]),
      },
    );
    const create = fake.requests[0]!;
    expect(create.url).toBe(`${HOST}/image_generation`);
    expect(header(create, 'authorization')).toBe(`Bearer ${KEY}`);
    expect(create.body).toEqual({
      model: 'image-01',
      prompt: 'a red fox',
      response_format: 'url',
      aspect_ratio: '16:9',
      n: 2,
      prompt_optimizer: true,
      seed: 3,
    });
    const media = fake.requests.filter((r) => r.url.startsWith(MEDIA));
    expect(media).toHaveLength(2);
    for (const request of media) {
      expect(header(request, 'authorization')).toBeUndefined();
      expect(JSON.stringify(request.headers ?? {})).not.toContain(KEY);
    }
    expect(items).toHaveLength(2);
    expect(items[0]!.json).toEqual({ url: `${MEDIA}/a.jpg`, id: 'img-1' });
    expect(items[0]!.binary?.data?.mimeType).toBe('image/jpeg');
    expect(items[1]!.binary?.data?.fileName).toBe('image-2.jpg');
  });

  it('returns only the links with Download Image off', async () => {
    const { fake, items } = await minimax(
      { resource: 'image', operation: 'generate', prompt: 'p', options: { downloadImage: false } },
      { handler: () => images([`${MEDIA}/a.jpg`]) },
    );
    expect(fake.requests).toHaveLength(1);
    expect(items[0]!.json).toMatchObject({ url: `${MEDIA}/a.jpg` });
    expect(items[0]!.binary).toBeUndefined();
  });

  it('refuses an empty prompt and a reply with no image', async () => {
    const empty = await minimax({ resource: 'image', operation: 'generate', prompt: '  ' });
    expect(empty.result.status).toBe('error');
    expect(empty.fake.requests).toHaveLength(0);
    const none = await minimax(
      { resource: 'image', operation: 'generate', prompt: 'p' },
      { handler: () => ({ body: { data: { image_urls: [] }, base_resp: ok } }) },
    );
    expect(none.result.status).toBe('error');
    const failed = await minimax(
      { resource: 'image', operation: 'generate', prompt: 'p' },
      { handler: () => ({ body: { base_resp: { status_code: 1026, status_msg: 'sensitive content' } } }) },
    );
    expect(JSON.stringify(failed.result.error)).toContain('sensitive content');
  });
});

describe('audio.textToSpeech', () => {
  const hex = Buffer.from('MP3BYTES').toString('hex');
  const speech = (audio: string) => ({
    body: { data: { audio, status: 2 }, extra_info: { audio_format: 'mp3' }, base_resp: ok },
  });

  it('sends the call and turns the hex reply into a binary field', async () => {
    const { fake, items } = await minimax(
      {
        resource: 'audio',
        operation: 'textToSpeech',
        text: 'hello there',
        options: {
          voiceId: 'Calm_Woman',
          speed: 1.5,
          volume: 2,
          pitch: 3,
          emotion: 'calm',
          languageBoost: 'English',
        },
      },
      { handler: () => speech(hex) },
    );
    const req = fake.requests[0]!;
    expect(req.url).toBe(`${HOST}/t2a_v2`);
    expect(header(req, 'authorization')).toBe(`Bearer ${KEY}`);
    expect(req.body).toEqual({
      model: 'speech-2.8-hd',
      text: 'hello there',
      stream: false,
      voice_setting: { voice_id: 'Calm_Woman', speed: 1.5, vol: 2, pitch: 3, emotion: 'calm' },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      output_format: 'hex',
      language_boost: 'English',
    });
    expect(fake.requests).toHaveLength(1);
    expect(items[0]!.binary?.data?.mimeType).toBe('audio/mpeg');
    expect(items[0]!.binary?.data?.fileName).toBe('speech.mp3');
    expect(Buffer.from(items[0]!.binary!.data!.data, 'base64').toString()).toBe('MP3BYTES');
  });

  it('downloads a link reply with no key', async () => {
    const { fake, items } = await minimax(
      { resource: 'audio', operation: 'textToSpeech', text: 'hi', options: { format: 'wav' } },
      {
        handler: (req) =>
          req.url.startsWith(MEDIA)
            ? { body: Buffer.from('WAVDATA'), headers: { 'content-type': 'audio/wav' } }
            : speech(`${MEDIA}/voice.wav`),
      },
    );
    const media = fake.requests.find((r) => r.url.startsWith(MEDIA))!;
    expect(header(media, 'authorization')).toBeUndefined();
    expect(items[0]!.json).toEqual({ url: `${MEDIA}/voice.wav` });
    expect(items[0]!.binary?.data?.mimeType).toBe('audio/wav');
    expect(items[0]!.binary?.data?.fileName).toBe('speech.wav');
  });

  it('asks for a link and keeps it with Download Audio off', async () => {
    const { fake, items } = await minimax(
      { resource: 'audio', operation: 'textToSpeech', text: 'hi', options: { downloadAudio: false } },
      { handler: () => speech(`${MEDIA}/voice.mp3`) },
    );
    expect((fake.requests[0]!.body as any).output_format).toBe('url');
    expect(fake.requests).toHaveLength(1);
    expect(items[0]!.json).toEqual({ url: `${MEDIA}/voice.mp3` });
  });

  it('refuses empty text, text that is too long and audio that is not hex', async () => {
    const empty = await minimax({ resource: 'audio', operation: 'textToSpeech', text: ' ' });
    expect(empty.result.status).toBe('error');
    const long = await minimax({ resource: 'audio', operation: 'textToSpeech', text: 'a'.repeat(10_001) });
    expect(long.result.status).toBe('error');
    expect(long.fake.requests).toHaveLength(0);
    const bad = await minimax(
      { resource: 'audio', operation: 'textToSpeech', text: 'hi' },
      { handler: () => speech('zz-not-hex') },
    );
    expect(bad.result.status).toBe('error');
  });
});

describe('video', () => {
  const created = (id = 'task-1') => ({ body: { task_id: id, base_resp: ok } });
  const state = (status: string, extra: DataObject = {}) => ({
    body: { task_id: 'task-1', status, ...extra, base_resp: ok },
  });
  const file = { body: { file: { file_id: 'f-9', download_url: `${MEDIA}/clip.mp4` }, base_resp: ok } };

  it('textToVideo creates, polls, retrieves the file and downloads it with no key', async () => {
    let polls = 0;
    const { fake, items } = await minimax(
      {
        resource: 'video',
        operation: 'textToVideo',
        modelId: 'MiniMax-Hailuo-2.3',
        prompt: 'waves',
        options: { duration: 10, resolution: '1080P', promptOptimizer: false },
      },
      {
        handler: (req) => {
          if (req.url.startsWith(MEDIA)) {
            return { body: Buffer.from('MP4'), headers: { 'content-type': 'video/mp4' } };
          }
          if (req.method === 'POST') return created();
          if (req.url.includes('/files/retrieve')) return file;
          polls++;
          return polls === 1 ? state('Processing') : state('Success', { file_id: 'f-9' });
        },
      },
    );
    const create = fake.requests[0]!;
    expect(create.url).toBe(`${HOST}/video_generation`);
    expect(header(create, 'authorization')).toBe(`Bearer ${KEY}`);
    expect(create.body).toEqual({
      model: 'MiniMax-Hailuo-2.3',
      prompt: 'waves',
      duration: 10,
      resolution: '1080P',
      prompt_optimizer: false,
    });
    const queries = fake.requests.filter((r) => r.url.includes('/query/video_generation'));
    expect(queries).toHaveLength(2);
    expect(queries[0]!.qs).toEqual({ task_id: 'task-1' });
    const retrieve = fake.requests.find((r) => r.url.includes('/files/retrieve'))!;
    expect(retrieve.qs).toEqual({ file_id: 'f-9' });
    expect(header(retrieve, 'authorization')).toBe(`Bearer ${KEY}`);
    const media = fake.requests.find((r) => r.url.startsWith(MEDIA))!;
    expect(header(media, 'authorization')).toBeUndefined();
    expect(JSON.stringify(media.headers ?? {})).not.toContain(KEY);
    expect(items[0]!.json).toEqual({ url: `${MEDIA}/clip.mp4`, taskId: 'task-1', fileId: 'f-9' });
    expect(items[0]!.binary?.data?.mimeType).toBe('video/mp4');
  });

  it('imageToVideo sends the first frame as a link or inline, and the last frame', async () => {
    const handler: FakeHandler = (req) => {
      if (req.method === 'POST') return created('task-2');
      if (req.url.includes('/files/retrieve')) return file;
      return state('Success', { file_id: 'f-9' });
    };
    const link = await minimax(
      {
        resource: 'video',
        operation: 'imageToVideo',
        prompt: 'zoom',
        inputType: 'url',
        imageUrl: `${MEDIA}/first.png`,
        options: { downloadVideo: false, lastFrameUrl: `${MEDIA}/last.png` },
      },
      { handler },
    );
    expect(link.fake.requests[0]!.body).toMatchObject({
      first_frame_image: `${MEDIA}/first.png`,
      last_frame_image: `${MEDIA}/last.png`,
    });
    expect(link.fake.requests.some((r) => r.url.startsWith(MEDIA))).toBe(false);
    expect(link.items[0]!.json).toMatchObject({ url: `${MEDIA}/clip.mp4` });
    expect(link.items[0]!.binary).toBeUndefined();

    const inline = await minimax(
      {
        resource: 'video',
        operation: 'imageToVideo',
        prompt: 'zoom',
        inputType: 'binary',
        binaryPropertyName: 'data',
        options: { downloadVideo: false, lastFrameField: 'end' },
      },
      {
        handler,
        items: [{ json: {}, binary: { data: bin('IMG', 'image/png'), end: bin('END', 'image/jpeg') } }],
      },
    );
    expect(inline.fake.requests[0]!.body).toMatchObject({
      first_frame_image: `data:image/png;base64,${b64('IMG')}`,
      last_frame_image: `data:image/jpeg;base64,${b64('END')}`,
    });
  });

  it('fails with a fixed text when the task fails, and when it never finishes', async () => {
    const failed = await minimax(
      { resource: 'video', operation: 'textToVideo', prompt: 'p' },
      { handler: (req) => (req.method === 'POST' ? created() : state('Fail')) },
    );
    expect(failed.result.status).toBe('error');
    expect(JSON.stringify(failed.result.error)).toContain('could not generate the video');
    pollTiming.timeoutMs = 30;
    const slow = await minimax(
      { resource: 'video', operation: 'textToVideo', prompt: 'p' },
      { handler: (req) => (req.method === 'POST' ? created() : state('Queueing')) },
    );
    expect(slow.result.status).toBe('error');
    expect(JSON.stringify(slow.result.error)).toContain('The video was not ready in time');
  });

  it('refuses an empty prompt, a bad image link and a task id with path characters', async () => {
    const empty = await minimax({ resource: 'video', operation: 'textToVideo', prompt: ' ' });
    expect(empty.result.status).toBe('error');
    expect(empty.fake.requests).toHaveLength(0);
    const bad = await minimax({
      resource: 'video',
      operation: 'imageToVideo',
      prompt: 'p',
      inputType: 'url',
      imageUrl: 'file:///etc/passwd',
    });
    expect(bad.result.status).toBe('error');
    expect(bad.fake.requests).toHaveLength(0);
    const badTask = await minimax(
      { resource: 'video', operation: 'textToVideo', prompt: 'p' },
      { handler: () => created('../../admin') },
    );
    expect(badTask.result.status).toBe('error');
    expect(badTask.fake.requests).toHaveLength(1);
  });

  it('gives an error item for a failed item with continue on fail', async () => {
    const { out } = await minimax(
      { resource: 'video', operation: 'textToVideo', prompt: ' ' },
      { onError: 'continueRegularOutput' },
    );
    expect(Object.keys(out[0] as object)).toEqual(['error']);
  });
});
