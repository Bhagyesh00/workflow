import { type DataObject, type Item, resolveNodeParameters } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpRequestNode } from '../src/nodes/core/HttpRequest.node';
import { keyValuePairs } from '../src/utils/utilities';
import { connect, node, runNode, runWorkflow } from './harness';
import { json, localHttp, startHttpServer } from './servers';

const items = (...list: object[]): Item[] => list.map((j) => ({ json: j as DataObject }));

describe('R58 HTTP Request keeps multipart body fields when a JSON Specify Body choice is still stored', () => {
  const properties = HttpRequestNode.description.properties;
  const fields = { parameters: [{ name: 'a', value: '1' }] };

  it('resolves the multipart fields although specifyBody is still json', () => {
    const resolved = resolveNodeParameters(properties, {
      sendBody: true,
      contentType: 'multipart-form-data',
      specifyBody: 'json',
      bodyParameters: fields,
    });
    expect(resolved.bodyParameters).toMatchObject(fields);
  });

  it('shows the body fields only for key/value JSON and form bodies, and always for multipart', () => {
    const resolve = (values: DataObject) => resolveNodeParameters(properties, { sendBody: true, ...values });
    expect(
      resolve({ contentType: 'json', specifyBody: 'json', bodyParameters: fields }).bodyParameters,
    ).toBeUndefined();
    expect(
      resolve({ contentType: 'json', specifyBody: 'keypair', bodyParameters: fields }).bodyParameters,
    ).toMatchObject(fields);
    expect(
      resolve({ contentType: 'form-urlencoded', specifyBody: 'keypair', bodyParameters: fields })
        .bodyParameters,
    ).toMatchObject(fields);
    expect(resolve({ contentType: 'raw', bodyParameters: fields }).bodyParameters).toBeUndefined();
  });

  it('sends the multipart fields of the run', async () => {
    const server = await startHttpServer((_req, res) => json(res, {}));
    try {
      const r = await runNode(
        'core.httpRequest',
        {
          url: `${server.url}/up`,
          method: 'POST',
          sendBody: true,
          contentType: 'multipart-form-data',
          specifyBody: 'json',
          bodyParameters: fields,
        },
        items({}),
        { services: { http: localHttp() } },
      );
      expect(r.status).toBe('success');
      expect(server.requests[0].body.toString()).toContain('name="a"');
    } finally {
      await server.close();
    }
  });
});

describe('R62 HTTP Request repeats rows of the same name', () => {
  let server: Awaited<ReturnType<typeof startHttpServer>>;

  beforeAll(async () => {
    server = await startHttpServer((req, res) =>
      json(res, {
        url: req.url,
        dup: req.headers['x-dup'],
        type: req.headers['content-type'],
        body: req.body.toString('utf8'),
      }),
    );
  });
  afterAll(async () => {
    await server.close();
  });

  it('sends every value of a repeated query parameter', async () => {
    const r = await runNode(
      'core.httpRequest',
      {
        url: `${server.url}/echo`,
        sendQuery: true,
        queryParameters: {
          parameters: [
            { name: 'status', value: 'open' },
            { name: 'status', value: 'pending' },
            { name: 'page', value: '1' },
          ],
        },
      },
      items({}),
      { services: { http: localHttp() } },
    );
    expect(r.status).toBe('success');
    expect(r.outputs[0][0].url).toBe('/echo?status=open&status=pending&page=1');
  });

  it('sends every value of a repeated header', async () => {
    const r = await runNode(
      'core.httpRequest',
      {
        url: `${server.url}/echo`,
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'x-dup', value: 'first' },
            { name: 'x-dup', value: 'last' },
          ],
        },
      },
      items({}),
      { services: { http: localHttp() } },
    );
    expect(r.outputs[0][0].dup).toBe('first, last');
  });

  it('sends every value of a repeated form-urlencoded body field', async () => {
    const r = await runNode(
      'core.httpRequest',
      {
        url: `${server.url}/echo`,
        method: 'POST',
        sendBody: true,
        contentType: 'form-urlencoded',
        specifyBody: 'keypair',
        bodyParameters: {
          parameters: [
            { name: 'id', value: '1' },
            { name: 'id', value: '2' },
            { name: 'page', value: '3' },
          ],
        },
      },
      items({}),
      { services: { http: localHttp() } },
    );
    expect(r.outputs[0][0].body).toBe('id=1&id=2&page=3');
  });

  it('sends every row of a multipart body, files included', async () => {
    const r = await runNode(
      'core.httpRequest',
      {
        url: `${server.url}/echo`,
        method: 'POST',
        sendBody: true,
        contentType: 'multipart-form-data',
        bodyParameters: {
          parameters: [
            { parameterType: 'formData', name: 'tag', value: 'a' },
            { parameterType: 'formData', name: 'tag', value: 'b' },
          ],
        },
      },
      items({}),
      { services: { http: localHttp() } },
    );
    const body = String(r.outputs[0][0].body);
    expect(body).toMatch(/name="tag"\r\n\r\na\r\n/);
    expect(body).toMatch(/name="tag"\r\n\r\nb\r\n/);
  });

  it('keeps the last value of a repeated key in the JSON key/value body', async () => {
    const r = await runNode(
      'core.httpRequest',
      {
        url: `${server.url}/echo`,
        method: 'POST',
        sendBody: true,
        contentType: 'json',
        specifyBody: 'keypair',
        bodyParameters: {
          parameters: [
            { name: 'k', value: 'one' },
            { name: 'k', value: 'two' },
          ],
        },
      },
      items({}),
      { services: { http: localHttp() } },
    );
    expect(JSON.parse(String(r.outputs[0][0].body))).toEqual({ k: 'two' });
  });

  it('nests dotted names in the JSON key/value body', async () => {
    const r = await runNode(
      'core.httpRequest',
      {
        url: `${server.url}/echo`,
        method: 'POST',
        sendBody: true,
        contentType: 'json',
        specifyBody: 'keypair',
        bodyParameters: {
          parameters: [
            { name: 'user.name', value: 'Ada' },
            { name: 'user.id', value: '1' },
            { name: 'tags[0]', value: 'x' },
            { name: 'user.__proto__.polluted', value: 'yes' },
            { name: 'flat', value: 'f' },
          ],
        },
      },
      items({}),
      { services: { http: localHttp() } },
    );
    expect(JSON.parse(String(r.outputs[0][0].body))).toEqual({
      user: { name: 'Ada', id: '1' },
      tags: ['x'],
      flat: 'f',
    });
    expect(({} as DataObject).polluted).toBeUndefined();
  });

  it('sends a query parameter named like an Object method once', async () => {
    const r = await runNode(
      'core.httpRequest',
      {
        url: `${server.url}/echo`,
        sendQuery: true,
        queryParameters: { parameters: [{ name: 'toString', value: 'x' }] },
      },
      items({}),
      { services: { http: localHttp() } },
    );
    expect(r.outputs[0][0].url).toBe('/echo?toString=x');
  });

  it('lets a Content-Type header row replace the raw body content type', async () => {
    const r = await runNode(
      'core.httpRequest',
      {
        url: `${server.url}/echo`,
        method: 'POST',
        sendBody: true,
        contentType: 'raw',
        body: '<a/>',
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/xml' }] },
      },
      items({}),
      { services: { http: localHttp() } },
    );
    expect(r.outputs[0][0].type).toBe('application/xml');
  });
});

describe('keyValuePairs with repeatKeys', () => {
  it('treats names of Object.prototype members as new keys', () => {
    expect(keyValuePairs([{ name: 'toString', value: 'x' }], { repeatKeys: true })).toEqual({ toString: 'x' });
    expect(
      keyValuePairs(
        [
          { name: 'valueOf', value: 'x' },
          { name: 'valueOf', value: 'y' },
        ],
        { repeatKeys: true },
      ),
    ).toEqual({ valueOf: ['x', 'y'] });
  });
});

describe('Merge', () => {
  const inputNode = (name: string, rows: object[], y: number) =>
    node(
      name,
      'core.code',
      { mode: 'runOnceForAllItems', jsCode: `return ${JSON.stringify(rows)}.map(json => ({ json }))` },
      [200, y],
    );
  const merge = (params: DataObject, inputs: object[][]) =>
    runWorkflow(
      [
        node('Start', 'core.manualTrigger'),
        ...inputs.map((rows, k) => inputNode(`In${k + 1}`, rows, k * 200)),
        node('Merge', 'core.merge', { numberInputs: inputs.length, ...params }, [400, 100]),
      ],
      connect(
        ...inputs.map((_, k): [string, string] => ['Start', `In${k + 1}`]),
        ...inputs.map((_, k): [string, string, number, number] => [`In${k + 1}`, 'Merge', 0, k]),
      ),
    );

  describe('R59 Always Add Input Number to Field Names', () => {
    it('suffixes every field with its input number, clashing or not', async () => {
      const run = await merge({ mode: 'combineByPosition', options: { clashHandling: 'addSuffix' } }, [
        [{ id: 1, a: 1 }],
        [{ id: 1, b: 2 }],
      ]);
      expect(run.json('Merge')).toEqual([{ id_1: 1, a_1: 1, id_2: 1, b_2: 2 }]);
    });

    it('uses the real input number when an earlier input has no item at the position', async () => {
      const run = await merge(
        { mode: 'combineByPosition', options: { clashHandling: 'addSuffix', includeUnpaired: true } },
        [[], [{ id: 2 }], [{ id: 3 }]],
      );
      expect(run.json('Merge')).toEqual([{ id_2: 2, id_3: 3 }]);
    });

    it('suffixes all combinations and matching-field joins the same way', async () => {
      const all = await merge({ mode: 'combineAllCombinations', options: { clashHandling: 'addSuffix' } }, [
        [{ a: 1 }],
        [{ b: 2 }],
      ]);
      expect(all.json('Merge')).toEqual([{ a_1: 1, b_2: 2 }]);
      const joined = await merge(
        {
          mode: 'combineByMatchingFields',
          fieldsToMatch: { values: [{ field1: 'id', field2: 'id' }] },
          joinMode: 'inner',
          options: { clashHandling: 'addSuffix' },
        },
        [[{ id: 1, a: 1 }], [{ id: 1, b: 2 }]],
      );
      expect(joined.json('Merge')).toEqual([{ id_1: 1, a_1: 1, id_2: 1, b_2: 2 }]);
    });

    it('suffixes the items without a partner in left, outer and right joins', async () => {
      const join = (joinMode: string, inputs: DataObject[][]) =>
        merge(
          {
            mode: 'combineByMatchingFields',
            fieldsToMatch: { values: [{ field1: 'id', field2: 'id' }] },
            joinMode,
            options: { clashHandling: 'addSuffix' },
          },
          inputs,
        );
      const rows1 = [
        { id: 1, a: 1 },
        { id: 3, a: 3 },
      ];
      const rows2 = [
        { id: 1, b: 2 },
        { id: 4, b: 4 },
      ];
      expect((await join('left', [rows1, rows2])).json('Merge')).toEqual([
        { id_1: 1, a_1: 1, id_2: 1, b_2: 2 },
        { id_1: 3, a_1: 3 },
      ]);
      expect((await join('outer', [rows1, rows2])).json('Merge')).toEqual([
        { id_1: 1, a_1: 1, id_2: 1, b_2: 2 },
        { id_1: 3, a_1: 3 },
        { id_2: 4, b_2: 4 },
      ]);
      expect((await join('right', [rows1, rows2])).json('Merge')).toEqual([
        { id_1: 1, a_1: 1, id_2: 1, b_2: 2 },
        { id_2: 4, b_2: 4 },
      ]);
      // keeping only the non-matches merges nothing, so the field names stay as they are
      expect((await join('antiLeft', [rows1, rows2])).json('Merge')).toEqual([{ id: 3, a: 3 }]);
      expect((await join('antiRight', [rows1, rows2])).json('Merge')).toEqual([{ id: 4, b: 4 }]);
    });
  });

  describe('R60 first-match-only keeps matched input 2 items out of the non-matches', () => {
    const rows1 = [{ id: 1 }];
    const rows2 = [{ id: 1, v: 'a' }, { id: 1, v: 'b' }, { id: 2 }];
    const join = (joinMode: string) =>
      merge(
        {
          mode: 'combineByMatchingFields',
          fieldsToMatch: { values: [{ field1: 'id', field2: 'id' }] },
          joinMode,
          options: { multipleMatches: 'first' },
        },
        [rows1, rows2],
      );

    it('antiRight outputs only the input 2 items without a partner', async () => {
      expect((await join('antiRight')).json('Merge')).toEqual([{ id: 2 }]);
    });

    it('outer outputs the first match once and only the real non-matches of input 2', async () => {
      expect((await join('outer')).json('Merge')).toEqual([{ id: 1, v: 'a' }, { id: 2 }]);
    });

    it('inner and left still output only the first match', async () => {
      expect((await join('inner')).json('Merge')).toEqual([{ id: 1, v: 'a' }]);
      expect((await join('left')).json('Merge')).toEqual([{ id: 1, v: 'a' }]);
    });
  });
});

describe('R61 Split Out treats a missing field as an empty list', () => {
  it('splits the items that have the field and skips the others', async () => {
    const r = await runNode(
      'core.splitOut',
      { fieldToSplitOut: 'lines' },
      items({ id: 1, lines: [{ sku: 'a' }, { sku: 'b' }] }, { id: 2 }, { id: 3, lines: [{ sku: 'c' }] }),
    );
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([{ sku: 'a' }, { sku: 'b' }, { sku: 'c' }]);
    // only some items lack the field: no hint
    expect(r.result.state.resultData.runData.Node[0].hints).toBeUndefined();
  });

  it('adds an info hint instead of an error when the field is missing from every item', async () => {
    const r = await runNode('core.splitOut', { fieldToSplitOut: 'lines' }, items({ id: 1 }, { id: 2 }));
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([]);
    expect(r.result.state.resultData.runData.Node[0].hints).toEqual([
      { message: "The field 'lines' wasn't found in any input item", level: 'info' },
    ]);
  });

  it('keeps a null field as one null value', async () => {
    const r = await runNode('core.splitOut', { fieldToSplitOut: 'lines' }, items({ id: 1, lines: null }));
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([{ lines: null }]);
    expect(r.result.state.resultData.runData.Node[0].hints).toBeUndefined();
  });

  it('treats each of several fields on its own and hints once per field found nowhere', async () => {
    const r = await runNode('core.splitOut', { fieldToSplitOut: 'a,b,c' }, items({ a: [1, 2] }, { b: [3] }));
    expect(r.status).toBe('success');
    // a field sets entries only for its own elements, as n8n does
    expect(r.outputs[0]).toEqual([{ a: 1 }, { a: 2 }, { b: 3 }]);
    expect(r.result.state.resultData.runData.Node[0].hints).toEqual([
      { message: "The field 'c' wasn't found in any input item", level: 'info' },
    ]);
  });

  it('keeps a null element of one of several fields, and leaves out the shorter field', async () => {
    const r = await runNode('core.splitOut', { fieldToSplitOut: 'a,b' }, items({ a: [1, null], b: [2] }));
    expect(r.outputs[0]).toEqual([{ a: 1, b: 2 }, { a: null }]);
  });
});
