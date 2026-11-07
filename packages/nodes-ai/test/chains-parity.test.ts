import { HttpClient } from '@workflow/core';
import type { AiChatRequest, Connections, DataObject, Item, WorkflowNode } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, FakeHttpClient, modelRequests, node, reply, run, scriptModel, services } from './harness';

beforeEach(() => modelRequests.clear());
afterEach(() => vi.useRealTimers());

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

/** Trigger -> root, a main model on slot 0 and, with `fallback`, a second model on slot 1. */
function setup(
  root: WorkflowNode,
  extra: WorkflowNode[] = [],
  fallback = false,
  links: Parameters<typeof connect> = [],
) {
  const connections: Connections = connect(
    ['Trigger', root.name],
    ['Model', root.name, 'ai_languageModel'],
    ...(fallback ? ([['Fallback', root.name, 'ai_languageModel']] as Parameters<typeof connect>) : []),
    ...links,
  );
  if (fallback) connections.Fallback.ai_languageModel![0]![0].index = 1;
  const nodes = [
    node('Trigger', 'test.trigger'),
    root,
    node('Model', 'test.fakeChatModel'),
    ...(fallback ? [node('Fallback', 'test.fakeChatModel')] : []),
    ...extra,
  ];
  return { nodes, connections };
}

async function chain(
  root: WorkflowNode,
  items: Item[],
  options: {
    extra?: WorkflowNode[];
    fallback?: boolean;
    links?: Parameters<typeof connect>;
    svc?: ReturnType<typeof services>;
  } = {},
) {
  const { nodes, connections } = setup(root, options.extra, options.fallback, options.links);
  return run(nodes, connections, { triggerItems: items, services: options.svc });
}

const json = (...rows: DataObject[]): Item[] => rows.map((row) => ({ json: row }));

describe('Basic LLM Chain fallback model', () => {
  const llm = (extra: DataObject = {}) =>
    node('Chain', 'ai.chainLlm', { promptType: 'define', text: 'Hi', needsFallback: true, ...extra });

  it('answers from the fallback model after the main model fails', async () => {
    scriptModel('Model', () => {
      throw new Error('Rate limit');
    });
    const fallbackRequests = scriptModel('Fallback', ['From the fallback']);
    const r = await chain(llm(), json({}), { fallback: true });
    expect(r.status).toBe('success');
    expect(r.output('Chain')).toEqual([{ text: 'From the fallback' }]);
    expect(modelRequests.get('Model')).toHaveLength(1);
    expect(fallbackRequests).toHaveLength(1);
    expect(fallbackRequests[0].messages).toEqual(modelRequests.get('Model')![0].messages);
  });

  it('does not touch the fallback model when the main model answers', async () => {
    scriptModel('Model', ['Main answer']);
    const fallbackRequests = scriptModel('Fallback', ['unused']);
    const r = await chain(llm(), json({}), { fallback: true });
    expect(r.output('Chain')).toEqual([{ text: 'Main answer' }]);
    expect(fallbackRequests).toHaveLength(0);
  });

  it('fails when both models fail', async () => {
    scriptModel('Model', () => {
      throw new Error('main down');
    });
    scriptModel('Fallback', () => {
      throw new Error('fallback down');
    });
    const r = await chain(llm(), json({}), { fallback: true });
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('fallback down');
  });

  it('asks for the second model when the option is on and none is connected', async () => {
    scriptModel('Model', ['x']);
    const r = await chain(llm(), json({}));
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('Fallback Model input');
  });
});

describe('Basic LLM Chain image messages', () => {
  const imageChain = (message: DataObject) =>
    node('Chain', 'ai.chainLlm', {
      promptType: 'define',
      text: 'Describe it',
      messages: { messageValues: [message] },
    });

  it('sends an Image (URL) message as a base64 part, fetched through the guarded client', async () => {
    const requests = scriptModel('Model', ['A cat']);
    const http = new FakeHttpClient(() => ({
      body: PNG,
      headers: { 'Content-Type': 'image/png; charset=x' },
    }));
    const r = await chain(
      imageChain({
        messageType: 'imageUrl',
        imageUrl: 'https://img.example.com/cat.png',
        imageDetail: 'low',
      }),
      json({}),
      { svc: services({ http }) },
    );
    expect(r.output('Chain')).toEqual([{ text: 'A cat' }]);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0].url).toBe('https://img.example.com/cat.png');
    expect(requests[0].messages).toEqual([
      { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }] },
      { role: 'user', content: 'Describe it' },
    ]);
  });

  it('takes the type from the file name when the server sends none', async () => {
    const requests = scriptModel('Model', ['ok']);
    const http = new FakeHttpClient(() => ({ body: PNG }));
    await chain(
      imageChain({ messageType: 'imageUrl', imageUrl: 'https://img.example.com/a/photo.JPG' }),
      json({}),
      {
        svc: services({ http }),
      },
    );
    expect((requests[0].messages[0].content as Array<{ mimeType: string }>)[0].mimeType).toBe('image/jpeg');
  });

  it('sends an Image (Binary) message from the item', async () => {
    const requests = scriptModel('Model', ['A dog']);
    const svc = services();
    const stored = await svc.binaryData.store(PNG, { fileName: 'dog.png', mimeType: 'image/png', executionId: 'e1' });
    const r = await chain(
      imageChain({ messageType: 'imageBinary', binaryImageDataKey: 'photo' }),
      [{ json: {}, binary: { photo: stored } }],
      { svc },
    );
    expect(r.output('Chain')).toEqual([{ text: 'A dog' }]);
    expect(requests[0].messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }],
    });
  });

  it('refuses a binary property that is not an image', async () => {
    scriptModel('Model', ['x']);
    const svc = services();
    const stored = await svc.binaryData.store(Buffer.from('hello'), {
      fileName: 'a.txt',
      mimeType: 'text/plain',
      executionId: 'e1',
    });
    const r = await chain(
      imageChain({ messageType: 'imageBinary' }),
      [{ json: {}, binary: { data: stored } }],
      { svc },
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('is not an image');
    expect(modelRequests.get('Model')).toHaveLength(0);
  });

  it('refuses an image URL on a blocked host, with no model request', async () => {
    scriptModel('Model', ['x']);
    const r = await chain(
      imageChain({ messageType: 'imageUrl', imageUrl: 'http://127.0.0.1:9/cat.png' }),
      json({}),
      { svc: services({ http: new HttpClient() }) },
    );
    expect(r.status).toBe('error');
    expect(modelRequests.get('Model')).toHaveLength(0);
  });

  it('fails a URL image over maxImageInputBytes without a model request', async () => {
    scriptModel('Model', ['x']);
    const http = new FakeHttpClient(() => ({
      body: Buffer.alloc(64),
      headers: { 'content-type': 'image/png' },
    }));
    const r = await chain(
      imageChain({ messageType: 'imageUrl', imageUrl: 'https://img.example.com/big.png' }),
      json({}),
      { svc: services({ http, nodeLimits: { maxImageInputBytes: 32 } }) },
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('larger than the limit of 32 bytes');
    expect(modelRequests.get('Model')).toHaveLength(0);
  });

  it('refuses a URL that is not an image', async () => {
    scriptModel('Model', ['x']);
    const http = new FakeHttpClient(() => ({
      body: Buffer.from('<html>'),
      headers: { 'content-type': 'text/html' },
    }));
    const r = await chain(
      imageChain({ messageType: 'imageUrl', imageUrl: 'https://img.example.com/page' }),
      json({}),
      {
        svc: services({ http }),
      },
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('did not return an image');
  });

  it('refuses a URL that is not http or https', async () => {
    scriptModel('Model', ['x']);
    const r = await chain(imageChain({ messageType: 'imageUrl', imageUrl: 'file:///etc/passwd' }), json({}));
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('http:// or https://');
  });
});

describe('Basic LLM Chain output parser toggle', () => {
  const list = node('List', 'ai.outputParserItemList', { options: { numberOfItems: 2 } });

  it('ignores a connected parser while the toggle is off', async () => {
    const requests = scriptModel('Model', ['- red\n- green']);
    const r = await chain(node('Chain', 'ai.chainLlm', { promptType: 'define', text: 'Colours' }), json({}), {
      extra: [list],
      links: [['List', 'Chain', 'ai_outputParser']],
    });
    expect(r.status).toBe('success');
    expect(r.output('Chain')).toEqual([{ text: '- red\n- green' }]);
    expect(requests[0].messages).toEqual([{ role: 'user', content: 'Colours' }]);
  });

  it('parses with the connected parser when the toggle is on, and returns a list as data', async () => {
    scriptModel('Model', ['- red\n- green\n- blue']);
    const r = await chain(
      node('Chain', 'ai.chainLlm', { promptType: 'define', text: 'Colours', hasOutputParser: true }),
      json({}),
      { extra: [list], links: [['List', 'Chain', 'ai_outputParser']] },
    );
    expect(r.output('Chain')).toEqual([{ data: ['red', 'green'] }]);
  });

  it('asks for a parser when the toggle is on and none is connected', async () => {
    scriptModel('Model', ['x']);
    const r = await chain(
      node('Chain', 'ai.chainLlm', { promptType: 'define', text: 'Colours', hasOutputParser: true }),
      json({}),
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('outputParser');
  });
});

describe('batching', () => {
  it('runs 5 items at a time by default and keeps the input order', async () => {
    let open = 0;
    let most = 0;
    scriptModel('Model', async (request: AiChatRequest) => {
      open++;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 15));
      open--;
      return reply(`echo ${request.messages.at(-1)!.content}`);
    });
    const rows = Array.from({ length: 7 }, (_, n) => ({ q: `q${n}` }));
    const r = await chain(
      node('Chain', 'ai.chainLlm', { promptType: 'define', text: '={{ $json.q }}' }),
      json(...rows),
    );
    expect(r.output('Chain')).toEqual(rows.map((row) => ({ text: `echo ${row.q}` })));
    expect(most).toBe(5);
  });

  it('waits the delay between batches (fake timers)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const requests = scriptModel('Model', ['a', 'b', 'c']);
    const pending = chain(
      node('Chain', 'ai.chainLlm', {
        promptType: 'define',
        text: '={{ $json.q }}',
        options: { batching: { batchSize: 2, delayBetweenBatches: 1000 } },
      }),
      json({ q: 1 }, { q: 2 }, { q: 3 }),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    const r = await pending;
    expect(requests).toHaveLength(3);
    expect(r.status).toBe('success');
    expect(r.output('Chain')).toEqual([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
  });

  it('applies to the Information Extractor, Classifier, Sentiment and Q&A chains', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const options = { batching: { batchSize: 1, delayBetweenBatches: 800 } };
    const cases: Array<[WorkflowNode, string[], WorkflowNode[]]> = [
      [
        node('Chain', 'ai.informationExtractor', {
          text: 'x',
          attributes: { attributes: [{ name: 'a', type: 'string' }] },
          options,
        }),
        ['{"a":"1"}', '{"a":"2"}'],
        [],
      ],
      [
        node('Chain', 'ai.textClassifier', { categories: { categories: [{ category: 'one' }] }, options }),
        ['{"one": true}', '{"one": true}'],
        [],
      ],
      [
        node('Chain', 'ai.sentimentAnalysis', { options }),
        ['{"sentiment":"Positive"}', '{"sentiment":"Positive"}'],
        [],
      ],
      [
        node('Chain', 'ai.chainRetrievalQa', { options }),
        ['one', 'two'],
        [
          node('Store', 'ai.vectorStoreInMemory', {
            mode: 'retrieve',
            memoryKey: `parity-${process.pid}-${Date.now()}`,
          }),
          node('Embeddings', 'test.fakeEmbeddings'),
        ],
      ],
    ];
    for (const [root, replies, extra] of cases) {
      modelRequests.clear();
      const requests = scriptModel('Model', replies);
      const hasStore = extra.length > 0;
      const { nodes, connections } = setup(
        root,
        extra,
        false,
        hasStore
          ? [
              ['Store', 'Chain', 'ai_vectorStore'],
              ['Embeddings', 'Store', 'ai_embedding'],
            ]
          : [],
      );
      const pending = run(nodes, connections, {
        triggerItems: json({ text: 'hello', chatInput: 'q1' }, { text: 'hello', chatInput: 'q2' }),
      });
      await vi.advanceTimersByTimeAsync(400);
      expect(requests, root.type).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(800);
      const r = await pending;
      expect(r.status, root.type).toBe('success');
      expect(requests, root.type).toHaveLength(2);
    }
  });

  it('keeps continue-on-fail per item inside a batch', async () => {
    scriptModel('Model', (request: AiChatRequest) => {
      if (String(request.messages.at(-1)!.content) === 'bad') throw new Error('boom');
      return reply('fine');
    });
    const r = await chain(
      node(
        'Chain',
        'ai.chainLlm',
        { promptType: 'define', text: '={{ $json.q }}' },
        { onError: 'continueRegularOutput' },
      ),
      json({ q: 'ok' }, { q: 'bad' }, { q: 'ok' }),
    );
    expect(r.output('Chain')).toEqual([{ text: 'fine' }, { error: 'boom' }, { text: 'fine' }]);
  });
});

describe('Text Classifier parity', () => {
  const categories = { categories: [{ category: 'billing' }, { category: 'support' }] };

  it('reports confidence scores under classification', async () => {
    const requests = scriptModel('Model', [
      '{"billing": {"match": true, "confidence": 0.9}, "support": {"match": false, "confidence": 0.1}}',
    ]);
    const r = await chain(
      node('Classify', 'ai.textClassifier', { categories, options: { includeConfidenceScores: true } }),
      json({ text: 'My invoice', id: 1 }),
    );
    expect(r.status).toBe('success');
    expect(r.outputs('Classify')).toEqual([
      [
        {
          text: 'My invoice',
          id: 1,
          classification: { category: 'billing', confidence: 0.9, scores: { billing: 0.9, support: 0.1 } },
        },
      ],
      [],
    ]);
    const schema = requests[0].responseFormat as unknown as { schema: { properties: DataObject } };
    expect(Object.keys(schema.schema.properties)).toEqual(['billing', 'support']);
  });

  it('adds no classification when scores are off', async () => {
    scriptModel('Model', ['{"billing": true, "support": false}']);
    const r = await chain(node('Classify', 'ai.textClassifier', { categories }), json({ text: 'x' }));
    expect(r.outputs('Classify')[0]).toEqual([{ text: 'x' }]);
  });

  it('refuses a category called confidence when scores are on', async () => {
    scriptModel('Model', ['{}']);
    const r = await chain(
      node('Classify', 'ai.textClassifier', {
        categories: { categories: [{ category: 'Confidence' }, { category: 'other' }] },
        options: { includeConfidenceScores: true },
      }),
      json({ text: 'x' }),
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('"confidence" is reserved');
    expect(modelRequests.get('Model')).toHaveLength(0);
  });

  it('accepts a category called confidence when scores are off', async () => {
    scriptModel('Model', ['{"confidence": true}']);
    const r = await chain(
      node('Classify', 'ai.textClassifier', { categories: { categories: [{ category: 'confidence' }] } }),
      json({ text: 'x' }),
    );
    expect(r.status).toBe('success');
  });

  it('states the exclusive and fallback rules in the prompt', async () => {
    const requests = scriptModel('Model', [
      '{"billing": false, "support": false}',
      '{"billing": false, "support": false}',
    ]);
    await chain(node('Classify', 'ai.textClassifier', { categories }), json({ text: 'x' }));
    const system = String(requests[0].messages[0].content);
    expect(system).toContain('Categories are mutually exclusive, and only one can be true.');
    expect(system).toContain('If there is not a very fitting category, select none of the categories.');
    await chain(
      node('Classify', 'ai.textClassifier', { categories, options: { multiClass: true } }),
      json({ text: 'x' }),
    );
    expect(String(requests[1].messages[0].content)).toContain('multiple can be true');
  });

  it('skips the corrective retry when auto-fixing is off', async () => {
    const requests = scriptModel('Model', ['not json at all', '{"billing": true, "support": false}']);
    const r = await chain(
      node('Classify', 'ai.textClassifier', { categories, options: { enableAutoFixing: false } }),
      json({ text: 'x' }),
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('could not be parsed');
    expect(requests).toHaveLength(1);
  });

  it('retries once when auto-fixing is on (the default)', async () => {
    const requests = scriptModel('Model', ['not json at all', '{"billing": true, "support": false}']);
    const r = await chain(node('Classify', 'ai.textClassifier', { categories }), json({ text: 'x' }));
    expect(r.status).toBe('success');
    expect(requests).toHaveLength(2);
  });
});

describe('Sentiment Analysis parity', () => {
  it('skips the corrective retry when auto-fixing is off', async () => {
    const requests = scriptModel('Model', ['mostly happy', '{"sentiment": "Positive"}']);
    const r = await chain(
      node('Sentiment', 'ai.sentimentAnalysis', { options: { enableAutoFixing: false } }),
      json({ text: 'Great' }),
    );
    expect(r.status).toBe('error');
    expect(requests).toHaveLength(1);
  });

  it('retries once by default', async () => {
    const requests = scriptModel('Model', ['mostly happy', '{"sentiment": "Positive"}']);
    const r = await chain(node('Sentiment', 'ai.sentimentAnalysis'), json({ text: 'Great' }));
    expect(r.status).toBe('success');
    expect(requests).toHaveLength(2);
  });
});
