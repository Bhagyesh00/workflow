import { createTriggerContext } from '@workflow/core';
import { type DataObject, ExpressionEvaluator, type Item, Workflow } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ruleToCron } from '../src';
import { node, nodeTypes, runNode, testServices } from './harness';
import { json, localHttp, startHttpServer } from './servers';

const items = (...list: object[]): Item[] => list.map((j) => ({ json: j as DataObject }));

describe('Manual Trigger and No Op', () => {
  it('pass items through with paired items', async () => {
    const manual = await runNode('core.manualTrigger', {}, items({ a: 1 }, { a: 2 }));
    expect(manual.outputs).toEqual([[{ a: 1 }, { a: 2 }]]);
    const noOp = await runNode('core.noOp', {}, items({ a: 1 }, { a: 2 }));
    expect(noOp.outputs).toEqual([[{ a: 1 }, { a: 2 }]]);
    expect(noOp.items[0].map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
  });

  it('allow only one manual trigger per workflow', () => {
    expect(nodeTypes.get('core.manualTrigger')!.description.maxNodes).toBe(1);
  });
});

describe('Schedule Trigger', () => {
  function triggerContext(mode: 'manual' | 'trigger', parameters: DataObject) {
    const wfNode = node('Schedule', 'core.scheduleTrigger', parameters);
    const workflow = new Workflow(
      { name: 's', nodes: [wfNode], connections: {}, settings: { timezone: 'Europe/Berlin' } },
      nodeTypes,
    );
    const emitted: Item[][][] = [];
    const ctx = createTriggerContext(
      {
        workflow,
        node: wfNode,
        services: testServices({}, { mode }),
        evaluator: new ExpressionEvaluator(),
        signal: new AbortController().signal,
      },
      {
        emit: (data) => void emitted.push(data),
        emitError: () => undefined,
        activationMode: mode === 'manual' ? 'manual' : 'activate',
      },
    );
    return { ctx, emitted };
  }

  it('emits once on a manual test, with date fields in the workflow timezone', async () => {
    const { ctx, emitted } = triggerContext('manual', {});
    const response = await nodeTypes.get('core.scheduleTrigger')!.trigger!(ctx);
    await response!.manualTriggerFunction!();
    expect(emitted).toHaveLength(1);
    expect(emitted[0][0][0].json).toMatchObject({ Timezone: expect.stringContaining('Europe/Berlin') });
  });

  it('registers a cron job per rule and stops them on close', async () => {
    const { ctx } = triggerContext('trigger', {
      rule: {
        interval: [
          { field: 'minutes', minutesInterval: 5 },
          { field: 'cronExpression', expression: '0 0 9 * * 1-5' },
        ],
      },
    });
    const registered: string[] = [];
    let stopped = 0;
    const spied = {
      ...ctx,
      registerCron: (expression: string) => {
        registered.push(expression);
        return () => void stopped++;
      },
    };
    const response = await nodeTypes.get('core.scheduleTrigger')!.trigger!(spied);
    expect(registered).toEqual(['0 */5 * * * *', '0 0 9 * * 1-5']);
    await response!.closeFunction!();
    expect(stopped).toBe(2);
  });

  it('rejects empty cron expressions', () => {
    expect(() => ruleToCron({ field: 'cronExpression', expression: ' ' })).toThrow(/empty/);
    expect(() => ruleToCron({ field: 'fortnights' as never })).toThrow(/Unknown schedule rule/);
  });
});

describe('Respond to Webhook', () => {
  const respond = async (parameters: DataObject, input: Item[] = items({ id: 1 }, { id: 2 })) => {
    const responses: unknown[] = [];
    const r = await runNode('core.respondToWebhook', parameters, input, {
      services: { hooks: { sendResponse: (res) => void responses.push(res) } },
    });
    return { r, responses };
  };

  it('responds with all items, text, redirects or files', async () => {
    expect((await respond({ respondWith: 'allIncomingItems' })).responses).toEqual([
      { statusCode: 200, headers: {}, body: [{ id: 1 }, { id: 2 }] },
    ]);
    expect((await respond({ respondWith: 'text', responseText: '=Hello {{ $json.id }}' })).responses).toEqual(
      [{ statusCode: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Hello 1' }],
    );
    expect(
      (await respond({ respondWith: 'redirect', redirectURL: 'https://example.com/thanks' })).responses,
    ).toEqual([{ statusCode: 307, headers: { location: 'https://example.com/thanks' }, body: undefined }]);
    const file = await respond({ respondWith: 'binary' }, [
      {
        json: {},
        binary: {
          data: {
            data: Buffer.from('PDF').toString('base64'),
            mimeType: 'application/pdf',
            fileName: 'a.pdf',
          },
        },
      },
    ]);
    expect(file.responses).toEqual([
      {
        statusCode: 200,
        headers: {},
        binary: { data: Buffer.from('PDF'), mimeType: 'application/pdf', fileName: 'a.pdf' },
      },
    ]);
  });

  it('fails when the binary property is missing', async () => {
    const { r } = await respond({ respondWith: 'binary', binaryProperty: 'nope' });
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/No binary data property "nope"/);
  });
});

describe('HTTP Request redirects', () => {
  let server: Awaited<ReturnType<typeof startHttpServer>>;
  beforeAll(async () => {
    server = await startHttpServer((req, res) => {
      if (req.url === '/old') {
        res.writeHead(302, { location: '/new' });
        return res.end();
      }
      return json(res, { at: req.url });
    });
  });
  afterAll(() => server.close());

  it('follows redirects by default and can stop at the 3xx response', async () => {
    const followed = await runNode('core.httpRequest', { url: `${server.url}/old` }, items({}), {
      services: { http: localHttp() },
    });
    expect(followed.outputs[0]).toEqual([{ at: '/new' }]);
    const stopped = await runNode(
      'core.httpRequest',
      {
        url: `${server.url}/old`,
        options: {
          redirect: { redirect: { followRedirects: false } },
          response: { response: { fullResponse: true } },
        },
      },
      items({}),
      { services: { http: localHttp() } },
    );
    expect(stopped.outputs[0][0]).toMatchObject({ statusCode: 302, headers: { location: '/new' } });
  });
});

describe('Markdown edge cases', () => {
  it('converts empty input to an empty string in a nested field', async () => {
    const r = await runNode(
      'core.markdown',
      { mode: 'markdownToHtml', markdown: '', destinationKey: 'out.html' },
      items({ keep: 1 }),
    );
    expect(r.outputs[0]).toEqual([{ keep: 1, out: { html: '' } }]);
  });
});
