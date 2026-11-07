/**
 * P5-02 Evaluation node: Set Inputs, Set Outputs (Data table by row_id with new columns, Google Sheets by
 * row_number RAW), Set Metrics (custom, string similarity, categorization, tools used, and the two AI judged
 * metrics against a scripted model), Check If Evaluating, the hints outside an evaluation, and `evaluationData`
 * only in mode `evaluation`. FakeTables and FakeHttpClient; no database, key or outside call.
 */
import { WorkflowExecute } from '@workflow/core';
import {
  type AiChatModel,
  type AiChatRequest,
  type Connections,
  type DataObject,
  EVALUATION_NODE_TYPE,
  EVALUATION_TRIGGER_TYPE,
  type NodeType,
  Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { EvaluationNode } from '../src/nodes/core/Evaluation.node';
import { levenshtein, similarity } from '../src/nodes/core/evaluation/levenshtein';
import { judgeScore, parseJudgeScore } from '../src/nodes/core/evaluation/metrics';
import { fillTemplate } from '../src/nodes/core/evaluation/prompts';
import { FakeTables } from './fake-tables';
import { connect, FakeHttpClient, node, nodeTypes, runNode, testServices } from './harness';

// ---- a scripted language model sub-node ----------------------------------------------------

interface Script {
  replies: Array<string | Error>;
  requests: AiChatRequest[];
  completion?: boolean;
}
const scripts = new Map<string, Script>();

const scriptedModel: NodeType = {
  description: {
    name: 'test.p5s3JudgeModel',
    displayName: 'Scripted judge',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Scripted judge' },
    inputs: [],
    outputs: ['ai_languageModel'],
    properties: [{ displayName: 'Script', name: 'script', type: 'string', default: '' }],
  },
  async supplyData(ctx) {
    const script = scripts.get(String(ctx.getNodeParameter('script', 0)));
    if (!script) throw new Error('no script');
    const model: AiChatModel = {
      kind: 'chatModel',
      provider: 'test',
      model: 'scripted',
      completion: script.completion,
      async chat(request) {
        script.requests.push(request);
        const reply = script.replies.shift();
        if (reply === undefined) throw new Error('script ran out');
        if (reply instanceof Error) throw reply;
        return { message: { role: 'assistant', content: reply } };
      },
    };
    return { response: model };
  },
};
nodeTypes.register(scriptedModel);

let scriptId = 0;
function script(replies: Array<string | Error>, completion = false) {
  const id = `s${++scriptId}`;
  const s: Script = { replies: [...replies], requests: [], completion };
  scripts.set(id, s);
  return { id, s };
}
const reply = (score: unknown) =>
  JSON.stringify({ extended_reasoning: 'because', reasoning_summary: 'short', score });

// ---- helpers -------------------------------------------------------------------------------

const EVAL = EVALUATION_NODE_TYPE;
const assign = (...pairs: Array<[string, unknown, string?]>) => ({
  assignments: pairs.map(([name, value, type], n) => ({ id: `a${n}`, name, value, type: type ?? 'string' })),
});

/** the workflow `Trigger -> Eval` (a dataset trigger, then the Evaluation node), run from the trigger */
async function runFromTrigger(
  parameters: DataObject,
  options: {
    mode?: 'manual' | 'evaluation';
    fake: FakeTables;
    triggerParams: DataObject;
    creds?: Record<string, DataObject>;
    http?: FakeHttpClient;
    model?: string;
    extraNodes?: WorkflowNode[];
    connections?: Connections;
  },
) {
  const credentials = Object.fromEntries(
    Object.keys(options.creds ?? {}).map((k) => [k, { id: k, name: k }]),
  );
  const nodes: WorkflowNode[] = [
    node('Trigger', EVALUATION_TRIGGER_TYPE, options.triggerParams, [0, 0], { credentials }),
    node('Eval', EVAL, parameters, [200, 0], { credentials }),
    ...(options.model ? [node('Judge', 'test.p5s3JudgeModel', { script: options.model }, [200, 200])] : []),
    ...(options.extraNodes ?? []),
  ];
  const connections: Connections = {
    ...connect(['Trigger', 'Eval']),
    ...(options.model
      ? { Judge: { ai_languageModel: [[{ node: 'Eval', type: 'ai_languageModel' as const, index: 0 }]] } }
      : {}),
    ...options.connections,
  };
  const workflow = new Workflow({ name: 'eval', nodes, connections }, nodeTypes);
  const services = testServices(options.creds, {
    dataTables: options.fake,
    mode: options.mode ?? 'manual',
    ...(options.http ? { http: options.http } : {}),
  });
  const result = await new WorkflowExecute(workflow, services).run({ startNode: 'Trigger' });
  const task = result.state.resultData.runData.Eval?.[0];
  return {
    status: result.status,
    error: result.state.resultData.error,
    runData: result.state.resultData.runData,
    items: (task?.data?.main?.[0] ?? []) as Array<{ json: DataObject; evaluationData?: DataObject }>,
    hints: task?.hints ?? [],
  };
}

function seeded(rows = 2) {
  const fake = new FakeTables();
  const table = fake.add('Cases', [
    { name: 'question', type: 'string' },
    { name: 'answer', type: 'string' },
  ]);
  const byId = { __rl: true, mode: 'id', value: table.id };
  return {
    fake,
    table,
    byId,
    triggerParams: { dataTableId: byId } as DataObject,
    fill: () =>
      fake.insertRows(
        table.id,
        Array.from({ length: rows }, (_, n) => ({ question: `q${n + 1}`, answer: '' })),
        'count',
      ),
    rows: () => fake.tables.get(table.id)?.rows ?? [],
  };
}

// ---- pure helpers --------------------------------------------------------------------------

describe('levenshtein and templates', () => {
  it('counts edits in whole characters', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
    expect(levenshtein('a😀b', 'a😀c')).toBe(1);
    expect(similarity('', '')).toBe(1);
    expect(similarity('abcd', 'wxyz')).toBe(0);
    expect(similarity('kitten', 'sitting')).toBeCloseTo(1 - 3 / 7, 10);
  });

  it('fills a template in one pass and never rescans a value', () => {
    const out = fillTemplate('A={actual_answer} E={expected_answer} Q={user_query} X={other}', {
      actual_answer: 'see {expected_answer}',
      expected_answer: '{actual_answer}',
    });
    expect(out).toBe('A=see {expected_answer} E={actual_answer} Q= X={other}');
  });

  it('accepts only a whole score from 1 to 5 in a JSON object', () => {
    expect(parseJudgeScore(reply(4))).toBe(4);
    expect(parseJudgeScore(`\`\`\`json\n${reply(1)}\n\`\`\``)).toBe(1);
    for (const bad of [reply(7), reply(0), reply(4.5), reply('4'), reply(null), '[]', 'nope', '']) {
      expect(() => parseJudgeScore(bad)).toThrow();
    }
  });
});

// ---- description ---------------------------------------------------------------------------

describe('Evaluation node description', () => {
  const d = EvaluationNode.description;
  it('has the four operations and the six metrics', () => {
    const options = (name: string) =>
      ((d.properties.find((p) => p.name === name)?.options ?? []) as Array<{ value: string }>).map(
        (o) => o.value,
      );
    expect(options('operation')).toEqual(['setOutputs', 'setInputs', 'setMetrics', 'checkIfEvaluating']);
    expect(options('metric')).toEqual([
      'correctness',
      'helpfulness',
      'stringSimilarity',
      'categorization',
      'toolsUsed',
      'customMetrics',
    ]);
    expect(d.properties.find((p) => p.name === 'operation')?.default).toBe('setOutputs');
  });
});

// ---- check if evaluating -------------------------------------------------------------------

describe('Check If Evaluating', () => {
  it('sends the items to the Evaluation output when the trigger ran', async () => {
    const s = seeded();
    await s.fill();
    const r = await runFromTrigger(
      { operation: 'checkIfEvaluating' },
      { fake: s.fake, triggerParams: s.triggerParams },
    );
    expect(r.status).toBe('success');
    const main = r.runData.Eval?.[0]?.data?.main ?? [];
    expect(main[0]).toHaveLength(1);
    expect(main[1] ?? []).toHaveLength(0);
  });

  it('sends the items to the Normal output when no evaluation trigger ran', async () => {
    const r = await runNode(EVAL, { operation: 'checkIfEvaluating' }, [
      { json: { a: 1 } },
      { json: { a: 2 } },
    ]);
    expect(r.status).toBe('success');
    expect(r.outputs[0] ?? []).toEqual([]);
    expect(r.outputs[1]).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('sends the items to the Evaluation output in mode evaluation', async () => {
    const s = seeded();
    await s.fill();
    const r = await runFromTrigger(
      { operation: 'checkIfEvaluating' },
      { fake: s.fake, triggerParams: s.triggerParams, mode: 'evaluation' },
    );
    expect(r.runData.Eval?.[0]?.data?.main?.[0]).toHaveLength(1);
  });
});

// ---- set inputs ----------------------------------------------------------------------------

describe('Set Inputs', () => {
  it('puts the inputs on the first item as evaluationData, in mode evaluation only', async () => {
    const s = seeded();
    await s.fill();
    const params = { operation: 'setInputs', inputs: assign(['question', 'What?'], ['n', 3, 'number']) };
    const evaluating = await runFromTrigger(params, {
      fake: s.fake,
      triggerParams: s.triggerParams,
      mode: 'evaluation',
    });
    expect(evaluating.status).toBe('success');
    expect(evaluating.items[0]?.evaluationData).toEqual({
      operation: 'setInputs',
      data: { question: 'What?', n: 3 },
    });
    expect(evaluating.items[0]?.json).toMatchObject({ question: 'q1' });
    const manual = await runFromTrigger(params, { fake: s.fake, triggerParams: s.triggerParams });
    expect(manual.items[0]?.evaluationData).toBeUndefined();
    expect(manual.items).toHaveLength(1);
  });

  it('passes the items through with a hint when no evaluation trigger ran', async () => {
    const params = { operation: 'setInputs', inputs: assign(['q', 'x']) };
    const r = await runNode(EVAL, params, [{ json: { a: 1 } }]);
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([{ a: 1 }]);
    expect(r.result.state.resultData.runData.Node?.[0]?.hints).toEqual([
      {
        message: "No inputs were set since the execution didn't start from an evaluation trigger",
        level: 'info',
      },
    ]);
    expect(r.items[0]?.[0]?.evaluationData).toBeUndefined();
  });

  it('fails with No inputs to set when the list is empty', async () => {
    const r = await runNode(EVAL, { operation: 'setInputs', inputs: assign() }, [{ json: {} }]);
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('No inputs to set');
  });
});

// ---- set outputs: data table ---------------------------------------------------------------

describe('Set Outputs (Data table)', () => {
  const outputsParams = (outputs: ReturnType<typeof assign>, byId: DataObject) => ({
    operation: 'setOutputs',
    source: 'dataTable',
    dataTableId: byId,
    outputs,
  });

  it('writes the outputs into the row of the trigger by row_id', async () => {
    const s = seeded(3);
    await s.fill();
    // a run from the trigger starts on the first row
    const r = await runFromTrigger(outputsParams(assign(['answer', 'A2']), s.byId), {
      fake: s.fake,
      triggerParams: s.triggerParams,
    });
    expect(r.status).toBe('success');
    expect(s.rows().map((row) => row.answer)).toEqual(['A2', '', '']);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.evaluationData).toBeUndefined();
    expect(s.fake.calls.filter((c) => c.startsWith('addColumn'))).toEqual([]);
  });

  it('adds missing columns with the type of the value, writes objects as text', async () => {
    const s = seeded(1);
    await s.fill();
    const outputs = assign(
      ['score', 5, 'number'],
      ['passed', true, 'boolean'],
      ['note', 'ok'],
      ['detail', { a: [1, 2] }, 'object'],
    );
    const r = await runFromTrigger(outputsParams(outputs, s.byId), {
      fake: s.fake,
      triggerParams: s.triggerParams,
      mode: 'evaluation',
    });
    expect(r.status).toBe('success');
    const columns = s.fake.tables.get(s.table.id)?.info.columns ?? [];
    expect(columns.map((c) => [c.name, c.type])).toEqual([
      ['question', 'string'],
      ['answer', 'string'],
      ['score', 'number'],
      ['passed', 'boolean'],
      ['note', 'string'],
      ['detail', 'string'],
    ]);
    expect(s.rows()[0]).toMatchObject({ score: 5, passed: true, note: 'ok', detail: '{"a":[1,2]}' });
    expect(r.items[0]?.evaluationData).toEqual({
      operation: 'setOutputs',
      data: { score: 5, passed: true, note: 'ok', detail: { a: [1, 2] } },
    });
  });

  it('converts a value for an existing text column', async () => {
    const s = seeded(1);
    await s.fill();
    await runFromTrigger(outputsParams(assign(['answer', 42, 'number']), s.byId), {
      fake: s.fake,
      triggerParams: s.triggerParams,
    });
    expect(s.rows()[0]?.answer).toBe('42');
  });

  it('lists the columns again once when another case added the same column first', async () => {
    class Racing extends FakeTables {
      raced = 0;
      override async addColumn(
        id: string,
        column: { name: string; type: 'string' | 'number' | 'boolean' | 'date' },
      ) {
        if (!this.raced) {
          this.raced += 1;
          // the other case wins: the column exists, and this call is told so
          await super.addColumn(id, column);
        }
        return super.addColumn(id, column);
      }
    }
    const fake = new Racing();
    const table = fake.add('Cases', [{ name: 'question', type: 'string' }]);
    await fake.insertRows(table.id, [{ question: 'q1' }], 'count');
    const byId = { __rl: true, mode: 'id', value: table.id };
    const r = await runFromTrigger(outputsParams(assign(['verdict', 'good']), byId), {
      fake,
      triggerParams: { dataTableId: byId },
    });
    expect(r.status).toBe('success');
    expect(fake.tables.get(table.id)?.rows[0]).toMatchObject({ verdict: 'good' });
    expect(fake.calls.filter((c) => c === 'addColumn:verdict')).toHaveLength(2);
  });

  it('fails when a column cannot be added and is still missing after the re-list', async () => {
    class Broken extends FakeTables {
      override async addColumn(): Promise<never> {
        throw new Error('Data table column limit reached');
      }
    }
    const fake = new Broken();
    const table = fake.add('Cases', [{ name: 'question', type: 'string' }]);
    await fake.insertRows(table.id, [{ question: 'q1' }], 'count');
    const byId = { __rl: true, mode: 'id', value: table.id };
    const r = await runFromTrigger(outputsParams(assign(['verdict', 'good']), byId), {
      fake,
      triggerParams: { dataTableId: byId },
    });
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('Data table column limit reached');
  });

  it('refuses an output named like a system column', async () => {
    const s = seeded(1);
    await s.fill();
    const r = await runFromTrigger(outputsParams(assign(['id', 'x']), s.byId), {
      fake: s.fake,
      triggerParams: s.triggerParams,
    });
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('Column name "id" is reserved as a system column name.');
  });

  it('fails when the dataset row is gone', async () => {
    const s = seeded(1);
    await s.fill();
    const gone = {
      type: 'and' as const,
      filters: [{ columnName: 'id', condition: 'gt' as const, value: 0 }],
    };
    const deleter = {
      ...outputsParams(assign(['answer', 'x']), s.byId),
    };
    // delete the row after the trigger read it: the write finds nothing
    const original = s.fake.updateRows.bind(s.fake);
    s.fake.updateRows = async (id, change, o) => {
      await s.fake.deleteRows(id, gone);
      return original(id, change, o);
    };
    const r = await runFromTrigger(deleter, { fake: s.fake, triggerParams: s.triggerParams });
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('The dataset row 1 is not in the data table any more');
  });

  it('passes the items through with a hint, and writes nothing, when no evaluation trigger ran', async () => {
    const s = seeded(1);
    await s.fill();
    const r = await runNode(EVAL, outputsParams(assign(['answer', 'x']), s.byId), [{ json: { a: 1 } }], {
      services: { dataTables: s.fake },
    });
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([{ a: 1 }]);
    expect(r.result.state.resultData.runData.Node?.[0]?.hints?.[0]?.message).toBe(
      "No outputs were set since the execution didn't start from an evaluation trigger",
    );
    expect(s.rows()[0]?.answer).toBe('');
  });

  it('fails with No outputs to set when the list is empty', async () => {
    const s = seeded(1);
    await s.fill();
    const r = await runFromTrigger(outputsParams(assign(), s.byId), {
      fake: s.fake,
      triggerParams: s.triggerParams,
    });
    expect(r.error?.message).toBe('No outputs to set');
  });

  it('fails when the trigger reads a sheet but the node writes a table', async () => {
    const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
    const http = new FakeHttpClient()
      .on('GET', `${SHEETS}/DOC1?`, () => ({ sheets: [{ properties: { sheetId: 0, title: 'Cases' } }] }))
      .on('GET', `${SHEETS}/DOC1/values/`, () => ({ values: [['question'], ['q1']] }));
    const s = seeded(1);
    await s.fill();
    const r = await runFromTrigger(outputsParams(assign(['answer', 'x']), s.byId), {
      fake: s.fake,
      http,
      creds: { googleSheetsOAuth2Api: { oauthTokenData: { access_token: 'ya29' } } },
      triggerParams: {
        source: 'googleSheets',
        documentId: { __rl: true, mode: 'id', value: 'DOC1' },
        sheetName: { __rl: true, mode: 'name', value: 'Cases' },
      },
    });
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe("The evaluation trigger's row has no row_id");
  });
});

// ---- set outputs: Google Sheets ------------------------------------------------------------

describe('Set Outputs (Google Sheets)', () => {
  const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
  const creds = { googleSheetsOAuth2Api: { oauthTokenData: { access_token: 'ya29.sheets' } } };
  const document = { __rl: true, mode: 'id', value: 'DOC1' };
  const sheet = { __rl: true, mode: 'name', value: "Bob's Cases" };
  const sheetParams = {
    source: 'googleSheets',
    authentication: 'oAuth2',
    documentId: document,
    sheetName: sheet,
  };

  function api(grid: unknown[][]) {
    return new FakeHttpClient()
      .on('GET', `${SHEETS}/DOC1?`, () => ({
        sheets: [{ properties: { sheetId: 3, title: "Bob's Cases" } }],
      }))
      .on('GET', `${SHEETS}/DOC1/values/`, (req) =>
        decodeURIComponent(req.url).includes('!1:1') ? { values: [grid[0]] } : { values: grid },
      )
      .on('PUT', `${SHEETS}/DOC1/values/`, () => ({}))
      .on('POST', `${SHEETS}/DOC1/values:batchUpdate`, () => ({ totalUpdatedRows: 1 }));
  }
  const fake = new FakeTables();

  it('writes the cells of the trigger row by row_number, RAW, and adds the missing header column', async () => {
    const http = api([
      ['question', 'answer'],
      ['q1', ''],
      ['q2', ''],
    ]);
    const r = await runFromTrigger(
      {
        operation: 'setOutputs',
        ...sheetParams,
        outputs: assign(['answer', 'A1'], ['score', 4, 'number'], ['d', { x: 1 }, 'object']),
      },
      { fake, http, creds, triggerParams: sheetParams, mode: 'evaluation' },
    );
    expect(r.status).toBe('success');
    const put = http.requests.find((req) => req.method === 'PUT');
    expect(decodeURIComponent(put?.url ?? '')).toContain("'Bob''s Cases'!A1:D1");
    expect(((put?.body ?? {}) as DataObject).values).toEqual([['question', 'answer', 'score', 'd']]);
    expect(put?.qs.valueInputOption).toBe('RAW');
    const batch = http.requests.find((req) => req.url.endsWith('values:batchUpdate'));
    expect(batch?.body).toEqual({
      valueInputOption: 'RAW',
      data: [
        { range: "'Bob''s Cases'!B2", values: [['A1']] },
        { range: "'Bob''s Cases'!C2", values: [[4]] },
        { range: "'Bob''s Cases'!D2", values: [['{"x":1}']] },
      ],
    });
    expect(batch?.headers.authorization).toBe('Bearer ya29.sheets');
    expect(r.items[0]?.evaluationData).toMatchObject({ operation: 'setOutputs' });
  });

  it('does not rewrite the header when every column is there', async () => {
    const http = api([
      ['question', 'answer'],
      ['q1', ''],
    ]);
    const r = await runFromTrigger(
      { operation: 'setOutputs', ...sheetParams, outputs: assign(['answer', 'A1']) },
      { fake, http, creds, triggerParams: sheetParams },
    );
    expect(r.status).toBe('success');
    expect(http.requests.some((req) => req.method === 'PUT')).toBe(false);
    expect(http.requests.every((req) => req.url.startsWith(SHEETS))).toBe(true);
  });
});

// ---- set metrics ---------------------------------------------------------------------------

describe('Set Metrics: custom, similarity, categorization, tools used', () => {
  const metrics = (parameters: DataObject, input: DataObject[] = [{}], mode?: 'evaluation') =>
    runNode(
      EVAL,
      { operation: 'setMetrics', ...parameters },
      input.map((json) => ({ json })),
      {
        services: mode ? { mode } : {},
      },
    );

  it('returns the custom metrics in the item json, and nothing else', async () => {
    const r = await metrics({
      metric: 'customMetrics',
      metrics: assign(['accuracy', 0.75, 'number'], ['cost', '2', 'number']),
    });
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([{ accuracy: 0.75, cost: 2 }]);
    expect(r.items[0]?.[0]?.evaluationData).toBeUndefined();
  });

  it('puts the metrics in evaluationData in mode evaluation', async () => {
    const r = await metrics(
      { metric: 'customMetrics', metrics: assign(['m', 1, 'number']) },
      [{}],
      'evaluation',
    );
    expect(r.items[0]?.[0]?.evaluationData).toEqual({ operation: 'setMetrics', data: { m: 1 } });
  });

  it('refuses a value that is not a number and a metric with no name', async () => {
    const text = await metrics({ metric: 'customMetrics', metrics: assign(['quality', 'high']) });
    expect(text.status).toBe('error');
    expect(text.error?.message).toBe("Value for 'quality' isn't a number");
    const nan = await metrics({ metric: 'customMetrics', metrics: assign(['q', Number.NaN, 'number']) });
    expect(nan.error?.message).toBe("Value for 'q' isn't a number");
    const unnamed = await metrics({ metric: 'customMetrics', metrics: assign(['', 1, 'number']) });
    expect(unnamed.error?.message).toBe('Metric name missing');
  });

  it('scores one metric per input item', async () => {
    const r = await metrics(
      { metric: 'categorization', expectedAnswer: '={{ $json.e }}', actualAnswer: '={{ $json.a }}' },
      [
        { e: 'spam', a: 'spam' },
        { e: 'spam', a: 'ham' },
      ],
    );
    expect(r.outputs[0]).toEqual([{ Categorization: 1 }, { Categorization: 0 }]);
  });

  it('scores string similarity as 1 - distance / longer length over trimmed texts', async () => {
    const r = await metrics({
      metric: 'stringSimilarity',
      expectedAnswer: ' kitten ',
      actualAnswer: 'sitting\n',
    });
    expect(r.outputs[0]?.[0]?.['String similarity']).toBeCloseTo(1 - 3 / 7, 10);
    const none = await metrics({ metric: 'stringSimilarity', expectedAnswer: 'abc', actualAnswer: 'xyz' });
    expect(none.outputs[0]).toEqual([{ 'String similarity': 0 }]);
  });

  it('names the missing side', async () => {
    const noExpected = await metrics({ metric: 'stringSimilarity', actualAnswer: 'x' });
    expect(noExpected.error?.message).toBe('Expected answer is missing');
    const noActual = await metrics({ metric: 'categorization', expectedAnswer: 'x' });
    expect(noActual.error?.message).toBe('Actual answer is missing');
    const blank = await metrics({ metric: 'stringSimilarity', expectedAnswer: '', actualAnswer: '' });
    expect(blank.error?.message).toBe('Expected answer is missing');
  });

  it('uses the metric name from the options', async () => {
    const r = await metrics({
      metric: 'categorization',
      expectedAnswer: 'a',
      actualAnswer: 'a',
      options: { metricName: 'Same label' },
    });
    expect(r.outputs[0]).toEqual([{ 'Same label': 1 }]);
  });

  const steps = [
    { action: { tool: 'Wikipedia', toolInput: {} }, observation: '' },
    { action: { tool: 'my_calculator' }, observation: '' },
  ];

  it('scores the share of the expected tools the agent used, ignoring case and the tool name rule', async () => {
    const all = await metrics({
      metric: 'toolsUsed',
      expectedTools: 'wikipedia, My Calculator',
      intermediateSteps: steps,
    });
    expect(all.outputs[0]).toEqual([{ 'Tools Used': 1 }]);
    const half = await metrics({
      metric: 'toolsUsed',
      expectedTools: 'Wikipedia,Search',
      intermediateSteps: steps,
    });
    expect(half.outputs[0]).toEqual([{ 'Tools Used': 0.5 }]);
    const none = await metrics({ metric: 'toolsUsed', expectedTools: 'Search', intermediateSteps: [] });
    expect(none.outputs[0]).toEqual([{ 'Tools Used': 0 }]);
    const text = await metrics({
      metric: 'toolsUsed',
      expectedTools: 'Wikipedia',
      intermediateSteps: JSON.stringify(steps),
    });
    expect(text.outputs[0]).toEqual([{ 'Tools Used': 1 }]);
  });

  it('names the missing tool list and missing steps', async () => {
    const noTools = await metrics({ metric: 'toolsUsed', expectedTools: ' , ', intermediateSteps: steps });
    expect(noTools.error?.message).toBe('Expected tool name missing');
    const noSteps = await metrics({ metric: 'toolsUsed', expectedTools: 'Wikipedia' });
    expect(noSteps.error?.message).toBe('Intermediate steps missing');
    const odd = await metrics({
      metric: 'toolsUsed',
      expectedTools: 'Wikipedia',
      intermediateSteps: 'not json',
    });
    expect(odd.error?.message).toBe('Intermediate steps missing');
  });

  it('keeps going on an item error when Continue On Fail is set', async () => {
    const r = await runNode(
      EVAL,
      {
        operation: 'setMetrics',
        metric: 'categorization',
        expectedAnswer: '={{ $json.e }}',
        actualAnswer: 'a',
      },
      [{ json: { e: 'a' } }, { json: {} }],
      { node: { onError: 'continueRegularOutput' } },
    );
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([{ Categorization: 1 }, { error: 'Expected answer is missing' }]);
  });
});

// ---- set metrics: AI judged ----------------------------------------------------------------

describe('Set Metrics: AI judged', () => {
  const aiParams = (metric: string, extra: DataObject = {}) => ({
    operation: 'setMetrics',
    metric,
    expectedAnswer: 'Paris',
    actualAnswer: 'The capital is Paris.',
    userQuery: 'Capital of France?',
    ...extra,
  });
  async function judged(
    metric: string,
    replies: Array<string | Error>,
    extra: DataObject = {},
    completion = false,
  ) {
    const { id, s } = script(replies, completion);
    const s2 = seeded(1);
    await s2.fill();
    const r = await runFromTrigger(aiParams(metric, extra), {
      fake: s2.fake,
      triggerParams: s2.triggerParams,
      model: id,
    });
    return { r, s };
  }

  it('takes the 1 to 5 score from a valid reply, for correctness and helpfulness', async () => {
    const c = await judged('correctness', [reply(4)]);
    expect(c.r.status).toBe('success');
    expect(c.r.items.map((i) => i.json)).toEqual([{ Correctness: 4 }]);
    const h = await judged('helpfulness', [reply(5)]);
    expect(h.r.items.map((i) => i.json)).toEqual([{ Helpfulness: 5 }]);
  });

  it('sends our rubric as system text, the values in the user text and a JSON schema', async () => {
    const { s } = await judged('correctness', [reply(3)]);
    expect(s.requests).toHaveLength(1);
    const request = s.requests[0] as AiChatRequest;
    expect(request.responseFormat).toMatchObject({ type: 'json' });
    expect(request.temperature).toBe(0);
    const [system, user] = request.messages;
    expect(system?.role).toBe('system');
    expect(String(system?.content)).toContain('"score"');
    expect(user?.role).toBe('user');
    const text = String(user?.content);
    expect(text).toContain('Paris');
    expect(text).toContain('The capital is Paris.');
    expect(text).toContain('Capital of France?');
    expect(text).not.toMatch(/\{(actual_answer|expected_answer|user_query)\}/);
  });

  it('fills the placeholders in one pass: an answer that holds a placeholder stays as written', async () => {
    const { s } = await judged('correctness', [reply(3)], {
      actualAnswer: 'echo {expected_answer} {user_query}',
    });
    expect(String(s.requests[0]?.messages[1]?.content)).toContain('echo {expected_answer} {user_query}');
  });

  it('uses the prompt from the options and the metric name', async () => {
    const { r, s } = await judged('helpfulness', [reply(2)], {
      options: { inputPrompt: 'Rate {actual_answer} for {user_query} please', metricName: 'Useful' },
    });
    expect(r.items.map((i) => i.json)).toEqual([{ Useful: 2 }]);
    expect(String(s.requests[0]?.messages[1]?.content)).toBe(
      'Rate The capital is Paris. for Capital of France? please',
    );
  });

  it('fails on a reply that is not JSON, with the model error in the description', async () => {
    const { r } = await judged('correctness', ['I think it is good']);
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('Failed to evaluate correctness');
    expect((r.error as { description?: string }).description).toBe(
      'Error from language model: The reply is not valid JSON',
    );
  });

  it('fails on a score of 7, 0, 4.5 or a text', async () => {
    for (const bad of [7, 0, 4.5, 'five']) {
      const { r } = await judged('helpfulness', [reply(bad)]);
      expect(r.status).toBe('error');
      expect(r.error?.message).toBe('Failed to evaluate helpfulness');
    }
  });

  it('shows a model error without a secret in it', async () => {
    const { r } = await judged('correctness', [new Error('401 for key sk-abcdefghijklmnopqrstuvwxyz123456')]);
    expect(r.status).toBe('error');
    const text = JSON.stringify(r.error);
    expect(text).toContain('Error from language model');
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
  });

  it('refuses a model that has no structured output', async () => {
    const { r, s } = await judged('correctness', [reply(4)], {}, true);
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('Language model does not support structured output');
    expect(s.requests).toHaveLength(0);
  });

  it('names the missing values before it calls the model', async () => {
    const noExpected = await judged('correctness', [reply(4)], { expectedAnswer: '  ' });
    expect(noExpected.r.error?.message).toBe('Expected answer is missing');
    const noActual = await judged('correctness', [reply(4)], { actualAnswer: '' });
    expect(noActual.r.error?.message).toBe('Actual answer is missing');
    const noQuery = await judged('helpfulness', [reply(4)], { userQuery: '' });
    expect(noQuery.r.error?.message).toBe('User query is missing');
    const noResponse = await judged('helpfulness', [reply(4)], { actualAnswer: '' });
    expect(noResponse.r.error?.message).toBe('Response is missing');
    expect([noExpected, noActual, noQuery, noResponse].every((x) => x.s.requests.length === 0)).toBe(true);
  });

  it('has the model input only for the two AI metrics, and fails without a model', async () => {
    // without a model the engine names the missing input
    const s2 = seeded(1);
    await s2.fill();
    const r = await runFromTrigger(aiParams('correctness'), {
      fake: s2.fake,
      triggerParams: s2.triggerParams,
    });
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('A sub-node must be connected');
    await expect(
      judgeScore({ metric: 'correctness', model: undefined, actualAnswer: 'a', expectedAnswer: 'b' }),
    ).rejects.toThrow('No language model connected');
  });

  it('gives the result in evaluationData in mode evaluation', async () => {
    const { id } = script([reply(5)]);
    const s2 = seeded(1);
    await s2.fill();
    const r = await runFromTrigger(aiParams('correctness'), {
      fake: s2.fake,
      triggerParams: s2.triggerParams,
      model: id,
      mode: 'evaluation',
    });
    expect(r.items[0]?.evaluationData).toEqual({ operation: 'setMetrics', data: { Correctness: 5 } });
  });
});
