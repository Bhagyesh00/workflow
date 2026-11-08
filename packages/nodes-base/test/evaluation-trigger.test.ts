/**
 * P5-02 Evaluation Trigger against FakeTables (Data table source) and recorded FakeHttpClient fixtures (Google
 * Sheets source): the first row, the next row, `_rowsLeft`, the limit and its cap, the row filter, the
 * `dataset.getRows` operation the test runner forces, the error texts, the credential each Authentication picks
 * and a service account that reads a sheet with no scope typed. No database, no key, no outside call.
 */
import { generateKeyPairSync } from 'node:crypto';
import { WorkflowExecute } from '@workflow/core';
import {
  DATASET_GET_ROWS,
  type DataObject,
  EVALUATION_TRIGGER_TYPE,
  MAX_EVALUATION_ROWS,
  Workflow,
} from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { EvaluationTriggerNode } from '../src/nodes/core/EvaluationTrigger.node';
import { FakeTables } from './fake-tables';
import { FakeHttpClient, nodeTypes, runNode, testServices } from './harness';

const TRIGGER = EVALUATION_TRIGGER_TYPE;
const QUESTIONS = [
  { name: 'question', type: 'string' as const },
  { name: 'points', type: 'number' as const },
];

function seeded(rows = 3) {
  const fake = new FakeTables();
  const table = fake.add('Cases', QUESTIONS);
  const byId = { __rl: true, mode: 'id', value: table.id };
  return {
    fake,
    table,
    byId,
    async fill(count = rows) {
      await fake.insertRows(
        table.id,
        Array.from({ length: count }, (_, n) => ({ question: `q${n + 1}`, points: n + 1 })),
        'count',
      );
    },
  };
}

const run = (parameters: DataObject, services: DataObject, input: DataObject[] = [{}]) =>
  runNode(
    TRIGGER,
    parameters,
    input.map((json) => ({ json })),
    { services: services as never },
  );

/** the Trigger as the only node, run the way the test runner runs it: `dataset.getRows` forced */
async function getRows(parameters: DataObject, services: DataObject, creds: Record<string, DataObject> = {}) {
  const workflow = new Workflow(
    {
      name: 'eval',
      nodes: [
        {
          id: 'trigger',
          name: 'Trigger',
          type: TRIGGER,
          typeVersion: 1,
          position: [0, 0],
          parameters,
          credentials: Object.fromEntries(Object.keys(creds).map((k) => [k, { id: k, name: k }])),
        },
      ],
      connections: {},
    },
    nodeTypes,
  );
  const result = await new WorkflowExecute(workflow, testServices(creds, services as never)).run({
    startNode: 'Trigger',
    forceOperation: DATASET_GET_ROWS,
  });
  const task = result.state.resultData.runData.Trigger?.[0];
  return {
    status: result.status,
    error: result.state.resultData.error,
    rows: ((task?.data?.main?.[0] ?? []) as Array<{ json: DataObject }>).map((item) => item.json),
  };
}

describe('Evaluation Trigger node description', () => {
  it('is the trigger with the n8n credentials and defaults', () => {
    const d = EvaluationTriggerNode.description;
    expect(d.name).toBe('core.evaluationTrigger');
    expect(d.group).toEqual(['trigger']);
    expect(d.inputs).toEqual([]);
    expect(d.credentials?.map((c) => c.name)).toEqual(['googleApi', 'googleSheetsOAuth2Api']);
    const prop = (name: string) => d.properties.find((p) => p.name === name);
    expect(prop('source')?.default).toBe('dataTable');
    expect(prop('maxRows')?.default).toBe(10);
    expect(prop('limitRows')?.default).toBe(false);
    expect(EvaluationTriggerNode.customOperations).toHaveProperty(DATASET_GET_ROWS);
  });
});

describe('Data table source', () => {
  it('gives the first row with row_number, row_id and _rowsLeft', async () => {
    const { fake, byId, fill } = seeded();
    await fill();
    const r = await run({ dataTableId: byId }, { dataTables: fake });
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([{ row_number: 1, row_id: 1, question: 'q1', points: 1, _rowsLeft: 2 }]);
  });

  it('gives the row after the previous one, and says No row found after the last', async () => {
    const { fake, byId, fill } = seeded();
    await fill();
    const second = await run({ dataTableId: byId }, { dataTables: fake }, [{ row_id: 1, row_number: 1 }]);
    expect(second.outputs[0]).toEqual([
      { row_number: 2, row_id: 2, question: 'q2', points: 2, _rowsLeft: 1 },
    ]);
    const last = await run({ dataTableId: byId }, { dataTables: fake }, [{ row_id: 2 }]);
    expect(last.outputs[0]).toEqual([{ row_number: 3, row_id: 3, question: 'q3', points: 3, _rowsLeft: 0 }]);
    const none = await run({ dataTableId: byId }, { dataTables: fake }, [{ row_id: 3 }]);
    expect(none.status).toBe('error');
    expect(none.error?.message).toBe('No row found');
  });

  it('says No row found for an empty table', async () => {
    const { fake, byId } = seeded();
    const r = await run({ dataTableId: byId }, { dataTables: fake });
    expect(r.error?.message).toBe('No row found');
  });

  it('reads only the first maxRows when Limit Rows is on', async () => {
    const { fake, byId, fill } = seeded();
    await fill(5);
    const r = await run({ dataTableId: byId, limitRows: true, maxRows: 2 }, { dataTables: fake });
    expect(r.outputs[0]).toMatchObject([{ row_id: 1, _rowsLeft: 1 }]);
    const edge = await run({ dataTableId: byId, limitRows: true, maxRows: 2 }, { dataTables: fake }, [
      { row_id: 2 },
    ]);
    expect(edge.error?.message).toBe('No row found');
  });

  it('keeps only the rows that match the filter, in order', async () => {
    const { fake, byId, fill } = seeded();
    await fill(5);
    const filters = { conditions: [{ keyName: 'points', condition: 'gt', keyValue: '2' }] };
    const r = await getRows(
      { dataTableId: byId, filterRows: true, matchType: 'allConditions', filters },
      { dataTables: fake },
    );
    expect(r.rows.map((row) => row.question)).toEqual(['q3', 'q4', 'q5']);
    expect(r.rows.map((row) => row.row_number)).toEqual([1, 2, 3]);
    const single = await run({ dataTableId: byId, filterRows: true, filters }, { dataTables: fake });
    expect(single.outputs[0]).toMatchObject([{ row_id: 3, question: 'q3', _rowsLeft: 2 }]);
  });

  it('does not filter when Filter Rows is off', async () => {
    const { fake, byId, fill } = seeded();
    await fill(3);
    const filters = { conditions: [{ keyName: 'points', condition: 'gt', keyValue: '2' }] };
    const r = await getRows({ dataTableId: byId, filterRows: false, filters }, { dataTables: fake });
    expect(r.rows).toHaveLength(3);
  });

  it('refuses a filter on a column the table does not have', async () => {
    const { fake, byId, fill } = seeded();
    await fill(1);
    const filters = { conditions: [{ keyName: 'nope', condition: 'eq', keyValue: 'x' }] };
    const r = await run({ dataTableId: byId, filterRows: true, filters }, { dataTables: fake });
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('nope');
  });

  it('names the table that does not exist, and asks for one when none is set', async () => {
    const { fake } = seeded();
    const missing = await run(
      { dataTableId: { __rl: true, mode: 'id', value: 'zzz' } },
      { dataTables: fake },
    );
    expect(missing.status).toBe('error');
    expect(missing.error?.message).toContain('zzz');
    const unset = await run({}, { dataTables: fake });
    expect(unset.error?.message).toBe('Select a data table');
  });

  it('fails when the data table module is off, and for an unknown source', async () => {
    const { byId } = seeded();
    const off = await run({ dataTableId: byId }, {});
    expect(off.error?.message).toBe('Attempted to use Data table node but the module is disabled');
    const odd = await run({ source: 'csv' }, {});
    expect(odd.error?.message).toBe('Unknown source "csv"');
  });
});

describe('dataset.getRows', () => {
  it('gives every row up to the limit with row_id and row_number, and no _rowsLeft', async () => {
    const { fake, byId, fill } = seeded();
    await fill(4);
    const all = await getRows({ dataTableId: byId }, { dataTables: fake });
    expect(all.status).toBe('success');
    expect(all.rows).toEqual([
      { row_number: 1, row_id: 1, question: 'q1', points: 1 },
      { row_number: 2, row_id: 2, question: 'q2', points: 2 },
      { row_number: 3, row_id: 3, question: 'q3', points: 3 },
      { row_number: 4, row_id: 4, question: 'q4', points: 4 },
    ]);
    const limited = await getRows({ dataTableId: byId, limitRows: true, maxRows: 2 }, { dataTables: fake });
    expect(limited.rows.map((row) => row.row_id)).toEqual([1, 2]);
  });

  it('keeps the row keys when the table has columns named row_id and row_number', async () => {
    const fake = new FakeTables();
    const table = fake.add('Imported', [
      { name: 'row_id', type: 'number' },
      { name: 'row_number', type: 'number' },
      { name: 'question', type: 'string' },
    ]);
    await fake.insertRows(
      table.id,
      [
        { row_id: 40, row_number: 90, question: 'q1' },
        { row_id: 41, row_number: 91, question: 'q2' },
      ],
      'count',
    );
    const r = await getRows(
      { dataTableId: { __rl: true, mode: 'id', value: table.id } },
      { dataTables: fake },
    );
    expect(r.rows).toEqual([
      { row_number: 1, row_id: 1, question: 'q1' },
      { row_number: 2, row_id: 2, question: 'q2' },
    ]);
  });

  it('gives an empty list for an empty table (the runner reports it)', async () => {
    const { fake, byId } = seeded();
    const r = await getRows({ dataTableId: byId }, { dataTables: fake });
    expect(r.status).toBe('success');
    expect(r.rows).toEqual([]);
  });

  it('never gives more than the hard cap, however high maxRows is', async () => {
    const { fake, byId, fill } = seeded();
    await fill(MAX_EVALUATION_ROWS + 5);
    const r = await getRows({ dataTableId: byId, limitRows: true, maxRows: 5000 }, { dataTables: fake });
    expect(r.rows).toHaveLength(MAX_EVALUATION_ROWS);
    const noLimit = await getRows({ dataTableId: byId }, { dataTables: fake });
    expect(noLimit.rows).toHaveLength(MAX_EVALUATION_ROWS);
    expect(noLimit.rows.at(-1)?.row_id).toBe(MAX_EVALUATION_ROWS);
  });
});

describe('Google Sheets source', () => {
  const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
  const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
  const doc = { __rl: true, mode: 'url', value: 'https://docs.google.com/spreadsheets/d/DOC1/edit#gid=0' };
  const sheet = { __rl: true, mode: 'name', value: 'Cases' };
  const grid = [
    ['question', 'expected', 'team'],
    ['What is 2+2?', '4', 'math'],
    [],
    ['Capital of France?', 'Paris', 'geo'],
    ['Largest planet?', 'Jupiter', 'geo'],
  ];
  const oauth = { googleSheetsOAuth2Api: { oauthTokenData: { access_token: 'ya29.sheets' } } };

  function sheetsApi() {
    return new FakeHttpClient()
      .on('GET', `${SHEETS}/DOC1?`, () => ({ sheets: [{ properties: { sheetId: 0, title: 'Cases' } }] }))
      .on('GET', `${SHEETS}/DOC1/values/`, () => ({ values: grid }));
  }
  const params = (extra: DataObject = {}) => ({
    source: 'googleSheets',
    authentication: 'oAuth2',
    documentId: doc,
    sheetName: sheet,
    ...extra,
  });
  const runSheet = (extra: DataObject, http: FakeHttpClient, input: DataObject[] = [{}]) =>
    runNode(
      TRIGGER,
      params(extra),
      input.map((json) => ({ json })),
      {
        creds: oauth,
        services: { http },
      },
    );

  it('gives the first non-empty row with its sheet row number and _rowsLeft', async () => {
    const http = sheetsApi();
    const r = await runSheet({}, http);
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([
      { row_number: 2, question: 'What is 2+2?', expected: '4', team: 'math', _rowsLeft: 2 },
    ]);
    expect(http.requests[0]?.headers.authorization).toBe('Bearer ya29.sheets');
    expect(http.requests.every((req) => req.url.startsWith(SHEETS))).toBe(true);
  });

  it('skips the empty row when it takes the row after the previous one', async () => {
    const r = await runSheet({}, sheetsApi(), [{ row_number: 2 }]);
    expect(r.outputs[0]).toMatchObject([{ row_number: 4, question: 'Capital of France?', _rowsLeft: 1 }]);
    const none = await runSheet({}, sheetsApi(), [{ row_number: 5 }]);
    expect(none.error?.message).toBe('No row found');
  });

  it('filters by lookup columns and limits the rows', async () => {
    const filtersUI = { values: [{ lookupColumn: 'team', lookupValue: 'geo' }] };
    const rows = await getRows(params({ filterRows: true, filtersUI }), { http: sheetsApi() }, oauth);
    expect(rows.rows.map((row) => row.row_number)).toEqual([4, 5]);
    const either = await getRows(
      params({
        filterRows: true,
        combineFilters: 'OR',
        filtersUI: {
          values: [
            { lookupColumn: 'team', lookupValue: 'math' },
            { lookupColumn: 'expected', lookupValue: 'Jupiter' },
          ],
        },
      }),
      { http: sheetsApi() },
      oauth,
    );
    expect(either.rows.map((row) => row.row_number)).toEqual([2, 5]);
    const limited = await getRows(params({ limitRows: true, maxRows: 2 }), { http: sheetsApi() }, oauth);
    expect(limited.rows.map((row) => row.row_number)).toEqual([2, 4]);
    const bad = await runSheet(
      { filterRows: true, filtersUI: { values: [{ lookupColumn: 'nope', lookupValue: 'x' }] } },
      sheetsApi(),
    );
    expect(bad.error?.message).toBe('Column "nope" is not in the sheet');
  });

  it('gives all rows for dataset.getRows, with no row_id', async () => {
    const r = await getRows(params(), { http: sheetsApi() }, oauth);
    expect(r.rows).toEqual([
      { row_number: 2, question: 'What is 2+2?', expected: '4', team: 'math' },
      { row_number: 4, question: 'Capital of France?', expected: 'Paris', team: 'geo' },
      { row_number: 5, question: 'Largest planet?', expected: 'Jupiter', team: 'geo' },
    ]);
  });

  it('keeps the sheet row number when a header is named row_number', async () => {
    const http = new FakeHttpClient()
      .on('GET', `${SHEETS}/DOC1?`, () => ({ sheets: [{ properties: { sheetId: 0, title: 'Cases' } }] }))
      .on('GET', `${SHEETS}/DOC1/values/`, () => ({
        values: [
          ['row_number', 'question'],
          ['7', 'What is 2+2?'],
        ],
      }));
    const r = await getRows(params(), { http }, oauth);
    expect(r.rows).toEqual([{ row_number: 2, question: 'What is 2+2?' }]);
  });

  it('signs with the credential Authentication picks: a service account reads the sheet with no scope typed', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const http = sheetsApi().on('POST', GOOGLE_TOKEN, () => ({ access_token: 'sa-token', expires_in: 3600 }));
    const r = await runNode(TRIGGER, params({ authentication: 'serviceAccount' }), [{ json: {} }], {
      creds: {
        googleApi: { email: 'sa@p.iam.gserviceaccount.com', privateKey: `${privateKey}\n\n\n\n`, scopes: '' },
      },
      services: { http },
    });
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toMatchObject([{ row_number: 2, question: 'What is 2+2?' }]);
    const token = http.requests.find((req) => req.url === GOOGLE_TOKEN);
    const assertion = String(((token?.body ?? {}) as { assertion?: string }).assertion).split('.')[1] ?? '';
    const claims = JSON.parse(Buffer.from(assertion, 'base64url').toString('utf8')) as { scope: string };
    expect(claims.scope.split(' ')).toEqual([
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.metadata',
    ]);
    const calls = http.requests.filter((req) => req.url.startsWith(SHEETS));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((req) => req.headers.authorization === 'Bearer sa-token')).toBe(true);
  });

  it('does not use the OAuth2 credential for a service account', async () => {
    const http = sheetsApi();
    const r = await runNode(TRIGGER, params({ authentication: 'serviceAccount' }), [{ json: {} }], {
      creds: oauth,
      services: { http },
    });
    expect(r.status).toBe('error');
    expect(http.requests.some((req) => req.headers.authorization === 'Bearer ya29.sheets')).toBe(false);
  });

  it('names a sheet that is not in the spreadsheet', async () => {
    const r = await runSheet({ sheetName: { __rl: true, mode: 'name', value: 'Other' } }, sheetsApi());
    expect(r.error?.message).toBe('Sheet "Other" was not found in the spreadsheet');
  });
});
