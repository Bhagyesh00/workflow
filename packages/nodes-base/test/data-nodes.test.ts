import { createHash, createHmac, generateKeyPairSync, verify } from 'node:crypto';
import type { Item } from '@workflow/workflow';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { connect, node, runNode, runWorkflow } from './harness';

const items = (...list: object[]): Item[] => list.map((json) => ({ json: json as Item['json'] }));

describe('Aggregate', () => {
  it('aggregates individual fields, with rename, merged lists and missing values', async () => {
    const r = await runNode(
      'core.aggregate',
      {
        fieldsToAggregate: {
          fieldToAggregate: [
            { fieldToAggregate: 'email' },
            { fieldToAggregate: 'tags', renameField: true, outputFieldName: 'allTags' },
          ],
        },
        options: { mergeLists: true, keepMissing: true },
      },
      items({ email: 'a@x.io', tags: ['a'] }, { email: 'b@x.io', tags: ['b', 'c'] }, { tags: [] }),
    );
    expect(r.outputs).toEqual([[{ email: ['a@x.io', 'b@x.io', null], allTags: ['a', 'b', 'c'] }]]);
    expect(r.items[0][0].pairedItem).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
  });

  it('aggregates all item data with field selection', async () => {
    const all = await runNode(
      'core.aggregate',
      { aggregate: 'aggregateAllItemData' },
      items({ a: 1 }, { a: 2 }),
    );
    expect(all.outputs).toEqual([[{ data: [{ a: 1 }, { a: 2 }] }]]);
    const except = await runNode(
      'core.aggregate',
      {
        aggregate: 'aggregateAllItemData',
        include: 'allFieldsExcept',
        fields: 'secret',
        destinationFieldName: 'rows',
      },
      items({ a: 1, secret: 'x' }),
    );
    expect(except.outputs).toEqual([[{ rows: [{ a: 1 }] }]]);
    const picked = await runNode(
      'core.aggregate',
      { aggregate: 'aggregateAllItemData', include: 'specifiedFields', fields: 'user.name' },
      items({ user: { name: 'Ada', age: 3 } }),
    );
    expect(picked.outputs).toEqual([[{ data: [{ user: { name: 'Ada' } }] }]]);
  });

  it('fails for a field no item has', async () => {
    const r = await runNode(
      'core.aggregate',
      { fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: 'nope' }] } },
      items({ a: 1 }),
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/"nope" is not in any input item/);
  });
});

describe('Split Out', () => {
  it('splits a list of objects into items and spreads object values', async () => {
    const r = await runNode(
      'core.splitOut',
      { fieldToSplitOut: 'lines', include: 'selectedOtherFields', fieldsToInclude: 'orderId' },
      items({ orderId: 7, lines: [{ sku: 'a' }, { sku: 'b' }], other: true }),
    );
    expect(r.outputs).toEqual([
      [
        { orderId: 7, sku: 'a' },
        { orderId: 7, sku: 'b' },
      ],
    ]);
    expect(r.items[0].map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 0 }]);
  });

  it('keeps primitives under the field or destination name and zips several fields', async () => {
    const r = await runNode(
      'core.splitOut',
      { fieldToSplitOut: 'tags', include: 'allOtherFields', options: { destinationFieldName: 'tag' } },
      items({ id: 1, tags: ['x', 'y'] }),
    );
    expect(r.outputs).toEqual([
      [
        { id: 1, tag: 'x' },
        { id: 1, tag: 'y' },
      ],
    ]);
    const zipped = await runNode(
      'core.splitOut',
      { fieldToSplitOut: 'a, b' },
      items({ a: [1, 2], b: ['x'] }),
    );
    expect(zipped.outputs).toEqual([
      [
        { a: 1, b: 'x' },
        // the shorter field sets no entry past its own elements
        { a: 2 },
      ],
    ]);
  });

  it('hints instead of failing for a field no item has', async () => {
    const r = await runNode('core.splitOut', { fieldToSplitOut: 'missing' }, items({ a: 1 }));
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([]);
    expect(r.result.state.resultData.runData.Node[0].hints).toEqual([
      { message: "The field 'missing' wasn't found in any input item", level: 'info' },
    ]);
    const some = await runNode('core.splitOut', { fieldToSplitOut: 'list' }, items({ a: 1 }, { list: [1] }));
    expect(some.outputs[0]).toEqual([{ list: 1 }]);
    expect(some.result.state.resultData.runData.Node[0].hints).toBeUndefined();
  });
});

describe('Sort', () => {
  it('sorts by several fields with natural ordering and nulls last', async () => {
    const r = await runNode(
      'core.sort',
      {
        sortFieldsUi: {
          sortField: [
            { fieldName: 'group', order: 'ascending' },
            { fieldName: 'n', order: 'descending' },
          ],
        },
      },
      items({ group: 'b', n: 1 }, { group: 'a', n: 2 }, { group: 'a', n: 10 }, { n: 5 }),
    );
    expect(r.outputs[0]).toEqual([
      { group: 'a', n: 10 },
      { group: 'a', n: 2 },
      { group: 'b', n: 1 },
      { n: 5 },
    ]);
    expect(r.items[0].map((i) => i.pairedItem)).toEqual([{ item: 2 }, { item: 1 }, { item: 0 }, { item: 3 }]);
  });

  it('sorts by an expression and shuffles randomly', async () => {
    const byExpr = await runNode(
      'core.sort',
      { type: 'expression', sortKey: '={{ $json.name.length }}', order: 'descending' },
      items({ name: 'Al' }, { name: 'Alexander' }, { name: 'Bob' }),
    );
    expect(byExpr.outputs[0].map((j) => j.name)).toEqual(['Alexander', 'Bob', 'Al']);
    const random = await runNode('core.sort', { type: 'random' }, items({ i: 1 }, { i: 2 }, { i: 3 }));
    expect(random.outputs[0].map((j) => j.i).sort()).toEqual([1, 2, 3]);
  });

  it('fails when no item has the sort field', async () => {
    const r = await runNode(
      'core.sort',
      { sortFieldsUi: { sortField: [{ fieldName: 'zzz' }] } },
      items({ a: 1 }),
    );
    expect(r.status).toBe('error');
  });
});

describe('Limit', () => {
  it('keeps first or last items', async () => {
    const first = await runNode('core.limit', { maxItems: 2 }, items({ i: 1 }, { i: 2 }, { i: 3 }));
    expect(first.outputs).toEqual([[{ i: 1 }, { i: 2 }]]);
    const last = await runNode(
      'core.limit',
      { maxItems: 2, keep: 'lastItems' },
      items({ i: 1 }, { i: 2 }, { i: 3 }),
    );
    expect(last.outputs).toEqual([[{ i: 2 }, { i: 3 }]]);
    expect(last.items[0].map((i) => i.pairedItem)).toEqual([{ item: 1 }, { item: 2 }]);
  });

  it('rejects negative limits', async () => {
    const r = await runNode('core.limit', { maxItems: -1 }, items({}));
    expect(r.status).toBe('error');
  });
});

describe('Remove Duplicates', () => {
  it('compares all fields, all-but-some, or selected fields', async () => {
    const data = items(
      { email: 'a', n: 1 },
      { email: 'a', n: 1 },
      { email: 'a', n: 2 },
      { email: 'b', n: 1 },
    );
    const all = await runNode('core.removeDuplicates', {}, data);
    expect(all.outputs[0]).toHaveLength(3);
    const except = await runNode(
      'core.removeDuplicates',
      { compare: 'allFieldsExcept', fieldsToExclude: 'n' },
      data,
    );
    expect(except.outputs[0]).toEqual([
      { email: 'a', n: 1 },
      { email: 'b', n: 1 },
    ]);
    const selected = await runNode(
      'core.removeDuplicates',
      { compare: 'selectedFields', fieldsToCompare: 'email', options: { removeOtherFields: true } },
      data,
    );
    expect(selected.outputs[0]).toEqual([{ email: 'a' }, { email: 'b' }]);
    expect(selected.items[0].map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 3 }]);
  });

  it('treats key order as irrelevant and errors for unknown fields', async () => {
    const r = await runNode('core.removeDuplicates', {}, items({ a: 1, b: 2 }, { b: 2, a: 1 }));
    expect(r.outputs[0]).toHaveLength(1);
    const bad = await runNode(
      'core.removeDuplicates',
      { compare: 'selectedFields', fieldsToCompare: 'nope' },
      items({ a: 1 }),
    );
    expect(bad.status).toBe('error');
  });
});

describe('Summarize', () => {
  const sales = items(
    { region: 'EU', amount: 10, customer: 'a' },
    { region: 'EU', amount: 5, customer: 'a' },
    { region: 'US', amount: '7', customer: 'b' },
  );

  it('summarizes grouped by fields', async () => {
    const r = await runNode(
      'core.summarize',
      {
        fieldsToSummarize: {
          values: [
            { aggregation: 'sum', field: 'amount' },
            { aggregation: 'average', field: 'amount' },
            { aggregation: 'countUnique', field: 'customer' },
            { aggregation: 'max', field: 'amount' },
            { aggregation: 'concatenate', field: 'customer', separator: '|' },
          ],
        },
        fieldsToSplitBy: 'region',
      },
      sales,
    );
    expect(r.outputs[0]).toEqual([
      {
        region: 'EU',
        sum_amount: 15,
        average_amount: 7.5,
        unique_count_customer: 1,
        max_amount: 10,
        concatenated_customer: 'a|a',
      },
      {
        region: 'US',
        sum_amount: 7,
        average_amount: 7,
        unique_count_customer: 1,
        max_amount: '7',
        concatenated_customer: 'b',
      },
    ]);
    expect(r.items[0][0].pairedItem).toEqual([{ item: 0 }, { item: 1 }]);
  });

  it('counts without grouping and can return one item', async () => {
    const r = await runNode(
      'core.summarize',
      {
        fieldsToSummarize: {
          values: [
            { aggregation: 'count', field: 'customer' },
            { aggregation: 'min', field: 'amount' },
          ],
        },
      },
      sales,
    );
    expect(r.outputs[0]).toEqual([{ count_customer: 3, min_amount: 5 }]);
    const single = await runNode(
      'core.summarize',
      {
        fieldsToSummarize: { values: [{ aggregation: 'count', field: 'customer' }] },
        fieldsToSplitBy: 'region',
        options: { outputFormat: 'singleItem' },
      },
      sales,
    );
    expect(single.outputs[0]).toEqual([
      {
        data: [
          { region: 'EU', count_customer: 2 },
          { region: 'US', count_customer: 1 },
        ],
      },
    ]);
  });

  it('fails for non-numeric sums and unknown fields', async () => {
    const bad = await runNode(
      'core.summarize',
      { fieldsToSummarize: { values: [{ aggregation: 'sum', field: 'customer' }] } },
      sales,
    );
    expect(bad.status).toBe('error');
    expect(bad.error?.message).toMatch(/not a number/);
    const missing = await runNode(
      'core.summarize',
      { fieldsToSummarize: { values: [{ aggregation: 'sum', field: 'nope' }] } },
      sales,
    );
    expect(missing.error?.message).toMatch(/not in any input item/);
  });
});

describe('Rename Keys', () => {
  it('renames nested keys and applies regex replacements without mutating input', async () => {
    const input = items({ user: { first_name: 'Ada' }, old_a: 1, nested: { old_b: 2 } });
    const r = await runNode(
      'core.renameKeys',
      {
        keys: { key: [{ currentKey: 'user.first_name', newKey: 'firstName' }] },
        additionalOptions: {
          regexReplacement: { replacements: [{ searchRegex: '^old_', replaceRegex: 'new_', depth: -1 }] },
        },
      },
      input,
    );
    expect(r.outputs[0]).toEqual([{ user: {}, firstName: 'Ada', new_a: 1, nested: { new_b: 2 } }]);
    expect(input[0].json).toEqual({ user: { first_name: 'Ada' }, old_a: 1, nested: { old_b: 2 } });
  });

  it('refuses prototype keys and invalid regular expressions', async () => {
    const proto = await runNode(
      'core.renameKeys',
      { keys: { key: [{ currentKey: 'a', newKey: '__proto__' }] } },
      items({ a: 1 }),
    );
    expect(proto.status).toBe('error');
    const regex = await runNode(
      'core.renameKeys',
      { additionalOptions: { regexReplacement: { replacements: [{ searchRegex: '(' }] } } },
      items({ a: 1 }),
    );
    expect(regex.error?.message).toMatch(/Invalid regular expression/);
  });
});

describe('Compare Datasets', () => {
  const compare = (params: Record<string, unknown>, a: object[], b: object[]) =>
    runWorkflow(
      [
        node('Start', 'core.manualTrigger'),
        node('A', 'core.code', { jsCode: `return ${JSON.stringify(a)}.map(json => ({ json }))` }, [200, 0]),
        node('B', 'core.code', { jsCode: `return ${JSON.stringify(b)}.map(json => ({ json }))` }, [200, 200]),
        node('Compare', 'core.compareDatasets', params, [400, 100]),
      ],
      connect(['Start', 'A'], ['Start', 'B'], ['A', 'Compare', 0, 0], ['B', 'Compare', 0, 1]),
    );
  const a = [
    { id: 1, name: 'Ada', role: 'admin' },
    { id: 2, name: 'Bob', role: 'user' },
    { id: 3, name: 'Cy', role: 'user' },
  ];
  const b = [
    { id: 1, name: 'Ada', role: 'admin' },
    { id: 2, name: 'Bob', role: 'admin' },
    { id: 4, name: 'Dee', role: 'user' },
  ];
  const params = { mergeByFields: { values: [{ field1: 'id', field2: 'id' }] } };

  it('routes to in A only, same, different and in B only', async () => {
    const run = await compare(params, a, b);
    expect(run.json('Compare', 0)).toEqual([{ id: 3, name: 'Cy', role: 'user' }]);
    expect(run.json('Compare', 1)).toEqual([{ id: 1, name: 'Ada', role: 'admin' }]);
    expect(run.json('Compare', 2)).toEqual([
      {
        keys: { id: 2 },
        same: { id: 2, name: 'Bob' },
        different: { role: { inputA: 'user', inputB: 'admin' } },
      },
    ]);
    expect(run.json('Compare', 3)).toEqual([{ id: 4, name: 'Dee', role: 'user' }]);
  });

  it('can prefer one version, skip fields and fuzzy-compare', async () => {
    const preferB = await compare({ ...params, resolve: 'preferInput2' }, a, b);
    expect(preferB.json('Compare', 2)).toEqual([{ id: 2, name: 'Bob', role: 'admin' }]);
    const skip = await compare({ ...params, options: { skipFields: 'role' } }, a, b);
    expect(skip.json('Compare', 1)).toHaveLength(2);
    const fuzzy = await compare(
      { ...params, options: { fuzzyCompare: true } },
      [{ id: '1', v: 1 }],
      [{ id: 1, v: '1' }],
    );
    expect(fuzzy.json('Compare', 1)).toHaveLength(1);
  });

  it('needs fields to match', async () => {
    const run = await compare({ mergeByFields: { values: [] } }, a, b);
    expect(run.status).toBe('error');
  });
});

describe('Date & Time', () => {
  it('adds, subtracts, formats, rounds and extracts', async () => {
    const date = '2024-03-15T10:42:30.000Z';
    const add = await runNode(
      'core.dateTime',
      { operation: 'addToDate', magnitude: date, timeUnit: 'days', duration: 20 },
      items({}),
    );
    expect(add.outputs[0][0].newDate).toBe('2024-04-04T10:42:30.000Z');
    const sub = await runNode(
      'core.dateTime',
      { operation: 'subtractFromDate', magnitude: date, timeUnit: 'hours', duration: 11 },
      items({}),
    );
    expect(sub.outputs[0][0].newDate).toBe('2024-03-14T23:42:30.000Z');
    const fmt = await runNode(
      'core.dateTime',
      {
        operation: 'formatDate',
        date,
        format: 'custom',
        customFormat: 'dd.MM.yyyy HH:mm',
        options: { timezone: 'Europe/Berlin' },
      },
      items({ keep: true }),
    );
    expect(fmt.outputs[0][0]).toEqual({ keep: true, formattedDate: '15.03.2024 11:42' });
    const unix = await runNode('core.dateTime', { operation: 'formatDate', date, format: 'X' }, items({}));
    expect(unix.outputs[0][0].formattedDate).toBe(1710499350);
    const up = await runNode(
      'core.dateTime',
      { operation: 'roundDate', date, mode: 'roundUp', toNearest: 'hour' },
      items({}),
    );
    expect(up.outputs[0][0].roundedDate).toBe('2024-03-15T11:00:00.000Z');
    const down = await runNode(
      'core.dateTime',
      { operation: 'roundDate', date, toNearest: 'month' },
      items({}),
    );
    expect(down.outputs[0][0].roundedDate).toBe('2024-03-01T00:00:00.000Z');
    const part = await runNode('core.dateTime', { operation: 'extractDate', date, part: 'week' }, items({}));
    expect(part.outputs[0][0].datePart).toBe(11);
  });

  it('computes time between dates and reads custom formats and timestamps', async () => {
    const diff = await runNode(
      'core.dateTime',
      {
        operation: 'getTimeBetweenDates',
        startDate: '2024-01-01T00:00:00Z',
        endDate: '2024-01-02T06:00:00Z',
        units: ['days', 'hours'],
      },
      items({}),
    );
    expect(diff.outputs[0][0].timeDifference).toEqual({ days: 1, hours: 6 });
    const iso = await runNode(
      'core.dateTime',
      {
        operation: 'getTimeBetweenDates',
        startDate: '01/01/2024',
        endDate: '={{ 1704153600 }}',
        units: ['hours'],
        options: { fromFormat: '', isoString: true },
      },
      items({}),
    );
    expect(iso.status).toBe('success');
    const custom = await runNode(
      'core.dateTime',
      {
        operation: 'formatDate',
        date: '31/12/2024',
        format: 'yyyy-MM-dd',
        options: { fromFormat: 'dd/MM/yyyy' },
      },
      items({}),
    );
    expect(custom.outputs[0][0].formattedDate).toBe('2024-12-31');
  });

  it('returns the current date in the workflow timezone', async () => {
    const r = await runNode('core.dateTime', { operation: 'getCurrentDate', includeTime: false }, items({}));
    const value = DateTime.fromISO(String(r.outputs[0][0].currentDate), { setZone: true });
    expect(value.isValid).toBe(true);
    expect(value.hour).toBe(0);
  });

  it('reports unreadable dates and unknown timezones', async () => {
    const bad = await runNode('core.dateTime', { operation: 'formatDate', date: 'yesterday-ish' }, items({}));
    expect(bad.status).toBe('error');
    expect(bad.error?.message).toMatch(/not a date/);
    const tz = await runNode(
      'core.dateTime',
      { operation: 'getCurrentDate', options: { timezone: 'Mars/Base' } },
      items({}),
    );
    expect(tz.error?.message).toMatch(/Unknown timezone/);
  });
});

describe('Crypto', () => {
  it('hashes and HMACs text and binary data', async () => {
    const hash = await runNode(
      'core.crypto',
      { action: 'hash', type: 'SHA256', value: '={{ $json.v }}' },
      items({ v: 'abc' }),
    );
    expect(hash.outputs[0][0]).toEqual({ v: 'abc', data: createHash('sha256').update('abc').digest('hex') });
    const md5 = await runNode(
      'core.crypto',
      { action: 'hash', type: 'MD5', value: 'abc', encoding: 'base64', dataPropertyName: 'h' },
      items({}),
    );
    expect(md5.outputs[0][0].h).toBe(createHash('md5').update('abc').digest('base64'));
    const hmac = await runNode(
      'core.crypto',
      { action: 'hmac', type: 'SHA512', value: 'msg', secret: 'k' },
      items({}),
    );
    expect(hmac.outputs[0][0].data).toBe(createHmac('sha512', 'k').update('msg').digest('hex'));
    const file = await runNode('core.crypto', { action: 'hash', type: 'SHA1', binaryData: true }, [
      {
        json: {},
        binary: { data: { data: Buffer.from('file!').toString('base64'), mimeType: 'text/plain' } },
      },
    ]);
    expect(file.outputs[0][0].data).toBe(createHash('sha1').update('file!').digest('hex'));
  });

  it('signs with a private key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const r = await runNode(
      'core.crypto',
      { action: 'sign', algorithm: 'ed25519', value: 'payload', privateKey: pem, encoding: 'base64' },
      items({}),
    );
    expect(
      verify(null, Buffer.from('payload'), publicKey, Buffer.from(String(r.outputs[0][0].data), 'base64')),
    ).toBe(true);
    const bad = await runNode(
      'core.crypto',
      { action: 'sign', value: 'x', privateKey: 'not a key' },
      items({}),
    );
    expect(bad.status).toBe('error');
    expect(bad.error?.message).toBe('Signing failed: check the private key and algorithm');
  });

  it('generates UUIDs and random strings', async () => {
    const uuid = await runNode('core.crypto', { action: 'generate' }, items({}));
    expect(uuid.outputs[0][0].data).toMatch(/^[0-9a-f-]{36}$/);
    const alnum = await runNode(
      'core.crypto',
      { action: 'generate', encodingType: 'ascii', stringLength: 20 },
      items({}),
    );
    expect(alnum.outputs[0][0].data).toMatch(/^[A-Za-z0-9]{20}$/);
    const hex = await runNode(
      'core.crypto',
      { action: 'generate', encodingType: 'hex', stringLength: 9 },
      items({}),
    );
    expect(hex.outputs[0][0].data).toMatch(/^[0-9a-f]{9}$/);
  });
});

describe('HTML', () => {
  const html = `<html><body><h1 class="t"> Hello   <b>World</b> </h1><script>evil()</script>
    <a href="/a">A</a><a href="/b">B</a><input name="q" value="term"></body></html>`;

  it('extracts text, html, attributes, values and arrays', async () => {
    const r = await runNode(
      'core.html',
      {
        extractionValues: {
          values: [
            { key: 'title', cssSelector: 'h1', returnValue: 'text' },
            { key: 'titleHtml', cssSelector: 'h1', returnValue: 'html' },
            {
              key: 'links',
              cssSelector: 'a',
              returnValue: 'attribute',
              attribute: 'href',
              returnArray: true,
            },
            { key: 'q', cssSelector: 'input', returnValue: 'value' },
            { key: 'body', cssSelector: 'body', returnValue: 'text', skipSelectors: 'a' },
            { key: 'none', cssSelector: '.missing', returnValue: 'text' },
          ],
        },
      },
      items({ data: html }),
    );
    expect(r.outputs[0][0]).toMatchObject({
      title: 'Hello World',
      titleHtml: 'Hello <b>World</b>',
      links: ['/a', '/b'],
      q: 'term',
      none: null,
    });
    expect(r.outputs[0][0].body).not.toMatch(/evil/);
  });

  it('builds an escaped HTML table from all items', async () => {
    const r = await runNode(
      'core.html',
      {
        operation: 'convertToHtmlTable',
        options: { caption: 'Users', tableAttributes: 'class="x" onclick="steal()"' },
      },
      items({ name: '<script>' }, { name: 'Bob', age: 3 }),
    );
    const table = String(r.outputs[0][0].table);
    expect(table).toContain('<caption>Users</caption>');
    expect(table).toContain('&lt;script&gt;');
    expect(table).toContain('<table class="x">');
    expect(table).not.toContain('onclick');
    expect(r.items[0][0].pairedItem).toEqual([{ item: 0 }, { item: 1 }]);
  });

  it('errors when the HTML field is missing', async () => {
    const r = await runNode(
      'core.html',
      { dataPropertyName: 'nope', extractionValues: { values: [] } },
      items({}),
    );
    expect(r.status).toBe('error');
  });
});

describe('XML', () => {
  it('converts XML to JSON with attributes and back', async () => {
    const xml = '<order id="7"><item sku="a">Pen</item><item sku="b">Ink</item><total>3</total></order>';
    const r = await runNode('core.xml', {}, items({ data: xml }));
    expect(r.outputs[0][0]).toEqual({
      order: {
        $: { id: '7' },
        item: [
          { $: { sku: 'a' }, _: 'Pen' },
          { $: { sku: 'b' }, _: 'Ink' },
        ],
        total: '3',
      },
    });
    const back = await runNode(
      'core.xml',
      { mode: 'jsonToxml', options: { headless: true, pretty: false } },
      items(r.outputs[0][0]),
    );
    expect(back.outputs[0][0].data).toBe(
      '<order id="7"><item sku="a">Pen</item><item sku="b">Ink</item><total>3</total></order>',
    );
  });

  it('wraps multi-key objects in a root element and supports explicit arrays', async () => {
    const r = await runNode(
      'core.xml',
      { mode: 'jsonToxml', options: { rootName: 'row', pretty: false } },
      items({ a: 1, b: 'x' }),
    );
    expect(r.outputs[0][0].data).toContain('<row><a>1</a><b>x</b></row>');
    const arr = await runNode(
      'core.xml',
      { options: { explicitArray: true, parseValues: true } },
      items({ data: '<r><n>1</n></r>', other: 1 }),
    );
    expect(arr.outputs[0][0]).toMatchObject({ other: 1, r: [{ n: [1] }] });
  });

  it('rejects invalid XML input', async () => {
    const r = await runNode('core.xml', {}, items({ data: 42 }));
    expect(r.status).toBe('error');
  });
});

describe('Markdown', () => {
  it('converts both ways', async () => {
    const toHtml = await runNode(
      'core.markdown',
      { mode: 'markdownToHtml', markdown: '# Title\n\n**bold** ~~x~~' },
      items({}),
    );
    expect(toHtml.outputs[0][0].data).toBe('<h1>Title</h1>\n<p><strong>bold</strong> <del>x</del></p>\n');
    const toMd = await runNode(
      'core.markdown',
      {
        html: '<h2>Hi</h2><p><em>a</em> <strong>b</strong></p><ul><li>x</li></ul><script>bad()</script>',
        destinationKey: 'md',
      },
      items({}),
    );
    expect(toMd.outputs[0][0].md).toBe('## Hi\n\n_a_ **b**\n\n-   x');
  });
});

describe('Convert to File / Extract from File', () => {
  it('round-trips CSV with formula escaping', async () => {
    const run = await runWorkflow(
      [
        node('Start', 'core.manualTrigger'),
        node('ToCsv', 'core.convertToFile', { operation: 'csv' }, [200, 0]),
        node('FromCsv', 'core.extractFromFile', { operation: 'csv' }, [400, 0]),
      ],
      connect(['Start', 'ToCsv'], ['ToCsv', 'FromCsv']),
      items({ name: 'Ada', note: 'a,b' }, { name: '=HYPERLINK("x")', tags: ['t'] }),
    );
    const file = run.items('ToCsv')[0].binary!.data;
    expect(file.mimeType).toBe('text/csv');
    expect(Buffer.from(file.data, 'base64').toString()).toBe(
      'name,note,tags\r\nAda,"a,b",\r\n"\'=HYPERLINK(""x"")",,"[""t""]"',
    );
    expect(run.json('FromCsv')).toEqual([
      { name: 'Ada', note: 'a,b', tags: '' },
      { name: '\'=HYPERLINK("x")', note: '', tags: '["t"]' },
    ]);
  });

  it('writes JSON (one or many files), text and base64 files and reads them back', async () => {
    const once = await runNode('core.convertToFile', { operation: 'toJson' }, items({ a: 1 }, { a: 2 }));
    expect(Buffer.from(once.items[0][0].binary!.data.data, 'base64').toString()).toBe('[{"a":1},{"a":2}]');
    const each = await runNode(
      'core.convertToFile',
      { operation: 'toJson', mode: 'each' },
      items({ a: 1 }, { a: 2 }),
    );
    expect(each.items[0]).toHaveLength(2);
    const text = await runNode(
      'core.convertToFile',
      { operation: 'toText', sourceProperty: 'body', options: { fileName: 'a.txt' } },
      items({ body: 'hello' }),
    );
    expect(text.items[0][0].binary!.data).toMatchObject({ fileName: 'a.txt', mimeType: 'text/plain' });
    const b64 = await runNode(
      'core.convertToFile',
      { operation: 'toBinary', sourceProperty: 'img' },
      items({ img: `data:image/png;base64,${Buffer.from('png!').toString('base64')}` }),
    );
    expect(b64.items[0][0].binary!.data.mimeType).toBe('image/png');
    expect(Buffer.from(b64.items[0][0].binary!.data.data, 'base64').toString()).toBe('png!');

    const binaryItem = (content: string): Item[] => [
      {
        json: { keep: 1 },
        binary: { data: { data: Buffer.from(content).toString('base64'), mimeType: 'text/plain' } },
      },
    ];
    const fromJson = await runNode(
      'core.extractFromFile',
      { operation: 'fromJson' },
      binaryItem('{"x":[1]}'),
    );
    expect(fromJson.outputs[0]).toEqual([{ data: { x: [1] } }]);
    const fromText = await runNode(
      'core.extractFromFile',
      { operation: 'text', options: { keepSource: true } },
      binaryItem('﻿hi'),
    );
    expect(fromText.outputs[0]).toEqual([{ keep: 1, data: 'hi' }]);
    const toB64 = await runNode(
      'core.extractFromFile',
      { operation: 'binaryToPropery', destinationKey: 'b' },
      binaryItem('xyz'),
    );
    expect(toB64.outputs[0]).toEqual([{ b: Buffer.from('xyz').toString('base64') }]);
  });

  it('builds and extracts HTML tables', async () => {
    const html = '<table><tr><th>Name</th><th>Age</th></tr><tr><td>Ada</td><td>36</td></tr></table>';
    const r = await runNode('core.extractFromFile', { operation: 'html' }, [
      { json: {}, binary: { data: { data: Buffer.from(html).toString('base64'), mimeType: 'text/html' } } },
    ]);
    expect(r.outputs[0]).toEqual([{ Name: 'Ada', Age: '36' }]);
    const toHtml = await runNode('core.convertToFile', { operation: 'html' }, items({ a: '<b>' }));
    expect(Buffer.from(toHtml.items[0][0].binary!.data.data, 'base64').toString()).toContain('&lt;b&gt;');
  });

  it('reads CSV without header rows, with limits and custom delimiters', async () => {
    const csv = 'a;b\n1;2\n3;4\n5;6';
    const r = await runNode(
      'core.extractFromFile',
      { operation: 'csv', options: { delimiter: ';', headerRow: false, fromLine: 1, maxRowCount: 2 } },
      [{ json: {}, binary: { data: { data: Buffer.from(csv).toString('base64'), mimeType: 'text/csv' } } }],
    );
    expect(r.outputs[0]).toEqual([
      { column_1: '1', column_2: '2' },
      { column_1: '3', column_2: '4' },
    ]);
  });

  it('fails clearly for missing binary data and invalid JSON', async () => {
    const missing = await runNode('core.extractFromFile', { operation: 'csv' }, items({}));
    expect(missing.status).toBe('error');
    expect(missing.error?.message).toMatch(/No binary data property "data"/);
    const badJson = await runNode('core.extractFromFile', { operation: 'fromJson' }, [
      {
        json: {},
        binary: { data: { data: Buffer.from('{nope').toString('base64'), mimeType: 'application/json' } },
      },
    ]);
    expect(badJson.error?.message).toMatch(/not valid JSON/);
    const badB64 = await runNode(
      'core.convertToFile',
      { operation: 'toBinary', sourceProperty: 'x' },
      items({ x: '%%%' }),
    );
    expect(badB64.error?.message).toMatch(/base64/);
  });
});
