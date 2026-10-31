import { createWebhookContext } from '@workflow/core';
import { type DataObject, ExpressionEvaluator, type Item, Workflow } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { connect, node, nodeTypes, runWorkflow, testServices } from './harness';

const items = (...list: object[]): Item[] => list.map((json) => ({ json: json as Item['json'] }));

/** call the Wait node's resume webhook() the way the server's /webhook-waiting handler does */
async function callWaitWebhook(parameters: DataObject, body: DataObject) {
  const workflow = new Workflow(
    { name: 'wait', nodes: [node('Wait', 'core.wait', parameters)], connections: {} },
    nodeTypes,
  );
  const ctx = createWebhookContext(
    {
      workflow,
      node: workflow.nodes.Wait,
      services: testServices(),
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    },
    { method: 'POST', headers: { 'content-type': 'application/json' }, query: {}, params: {}, body },
    'default',
  );
  return nodeTypes.get('core.wait')!.webhook!(ctx);
}

describe('Wait resume webhook (R36)', () => {
  it('refuses to resume a time interval wait early', async () => {
    const response = await callWaitWebhook(
      { resume: 'timeInterval', amount: 3, unit: 'days' },
      { injected: true },
    );
    expect(response.workflowData).toBeUndefined();
    expect(response.webhookResponse?.statusCode).toBe(404);
  });

  it('refuses to resume a specific time wait early', async () => {
    const response = await callWaitWebhook(
      { resume: 'specificTime', dateTime: '2999-01-01T00:00:00Z' },
      { injected: true },
    );
    expect(response.workflowData).toBeUndefined();
    expect(response.webhookResponse?.statusCode).toBe(404);
  });

  it('still resumes a webhook wait with the request data', async () => {
    const response = await callWaitWebhook({ resume: 'webhook' }, { approved: true });
    expect(response.workflowData?.[0][0].json).toMatchObject({ body: { approved: true } });
  });
});

describe('Loop Over Items paired items (R35)', () => {
  // needs PairedItem.sourceOverwrite in @workflow/workflow and the loop's first-run input source in the
  // execute context; the loop cannot express "an item of an earlier run's input" until then
  it.fails('resolves a pre-loop node item inside later batches and after the done output', async () => {
    const run = await runWorkflow(
      [
        node('T', 'core.manualTrigger'),
        node('Loop', 'core.splitInBatches', { batchSize: 1 }, [200, 0]),
        node(
          'Body',
          'core.set',
          {
            assignments: {
              assignments: [{ name: 'orig', value: "={{ $('T').item.json.name }}", type: 'string' }],
            },
          },
          [400, 100],
        ),
        node(
          'After',
          'core.set',
          {
            assignments: {
              assignments: [{ name: 'orig', value: "={{ $('T').item.json.name }}", type: 'string' }],
            },
          },
          [400, -100],
        ),
      ],
      connect(['T', 'Loop'], ['Loop', 'After', 0], ['Loop', 'Body', 1], ['Body', 'Loop']),
      items({ name: 'A' }, { name: 'B' }, { name: 'C' }),
    );
    expect(run.error?.message).toBeUndefined();
    expect(run.status).toBe('success');
    expect(run.runData.Body.map((task) => task.data?.main?.[0]?.[0].json.orig)).toEqual(['A', 'B', 'C']);
    expect(run.json('After').map((json) => json.orig)).toEqual(['A', 'B', 'C']);
  });
});
