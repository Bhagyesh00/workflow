import type { DataObject, Item } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { columnIndex, columnLetter, quoteSheet } from '../src/nodes/apps/google/GoogleSheets.node';
import { buildMimeMessage, simplifyGmailMessage } from '../src/nodes/apps/google/mime';
import { contextFor } from './contexts';
import { FakeHttpClient, runNode } from './harness';

const items = (...list: object[]): Item[] => list.map((json) => ({ json: json as DataObject }));
const gmailCreds = { gmailOAuth2: { oauthTokenData: { access_token: 'ya29.gmail' } } };
const sheetsCreds = { googleSheetsOAuth2Api: { oauthTokenData: { access_token: 'ya29.sheets' } } };
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const b64url = (s: string) => Buffer.from(s).toString('base64url');
const decodeRaw = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');

function gmailMessage(id: string, overrides: DataObject = {}): DataObject {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'Hello there',
    internalDate: String(Date.parse('2024-05-01T10:00:00Z')),
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: 'Ada <ada@example.com>' },
        { name: 'To', value: 'me@example.com' },
        { name: 'Subject', value: 'Invoice 7' },
        { name: 'Message-ID', value: '<m1@example.com>' },
        { name: 'References', value: '<m0@example.com>' },
      ],
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64url('Hello there') } },
            { mimeType: 'text/html', body: { data: b64url('<p>Hello there</p>') } },
          ],
        },
        { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { attachmentId: 'att1', size: 4 } },
      ],
    },
    ...overrides,
  };
}

describe('MIME helpers', () => {
  it('builds multipart messages with encoded headers and blocks header injection', () => {
    const mime = buildMimeMessage({
      to: 'bob@example.com\r\nBcc: evil@example.com',
      subject: 'Grüße',
      text: 'plain',
      html: '<b>rich</b>',
      attachments: [{ fileName: 'a.txt', mimeType: 'text/plain', data: Buffer.from('file') }],
    });
    expect(mime).toContain('To: bob@example.com Bcc: evil@example.com');
    expect(mime).not.toMatch(/^Bcc:/m);
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from('Grüße').toString('base64')}?=`);
    expect(mime).toContain('multipart/mixed');
    expect(mime).toContain('multipart/alternative');
    expect(mime).toContain('filename="a.txt"');
    expect(mime).toContain(Buffer.from('file').toString('base64'));
  });

  it('simplifies Gmail API messages', () => {
    const simple = simplifyGmailMessage(gmailMessage('m1'));
    expect(simple).toMatchObject({
      id: 'm1',
      from: 'Ada <ada@example.com>',
      subject: 'Invoice 7',
      text: 'Hello there',
      html: '<p>Hello there</p>',
      internalDate: '2024-05-01T10:00:00.000Z',
      attachments: [{ fileName: 'invoice.pdf', attachmentId: 'att1', mimeType: 'application/pdf', size: 4 }],
    });
  });
});

describe('Gmail', () => {
  it('sends a message as base64url MIME with attachments', async () => {
    const http = new FakeHttpClient().on('POST', `${GMAIL}/messages/send`, () => ({
      id: 'sent1',
      threadId: 't1',
      labelIds: ['SENT'],
    }));
    const r = await runNode(
      'app.gmail',
      {
        resource: 'message',
        operation: 'send',
        sendTo: 'bob@example.com',
        subject: '=Order {{ $json.id }}',
        emailType: 'text',
        message: 'Thanks!',
        options: { ccList: 'cc@example.com', attachments: 'invoice' },
      },
      [
        {
          json: { id: 7 },
          binary: {
            invoice: {
              data: Buffer.from('PDF').toString('base64'),
              mimeType: 'application/pdf',
              fileName: 'inv.pdf',
            },
          },
        },
      ],
      { creds: gmailCreds, services: { http } },
    );
    expect(r.outputs[0]).toEqual([{ id: 'sent1', threadId: 't1', labelIds: ['SENT'] }]);
    const req = http.requests[0];
    expect(req.headers.authorization).toBe('Bearer ya29.gmail');
    const mime = decodeRaw((req.body as DataObject).raw as string);
    expect(mime).toContain('To: bob@example.com');
    expect(mime).toContain('Cc: cc@example.com');
    expect(mime).toContain('Subject: Order 7');
    expect(mime).toContain(Buffer.from('Thanks!').toString('base64'));
    expect(mime).toContain('filename="inv.pdf"');
  });

  it('replies in the thread with In-Reply-To and References', async () => {
    const http = new FakeHttpClient()
      .on('GET', `${GMAIL}/messages/m1`, () => gmailMessage('m1'))
      .on('POST', `${GMAIL}/messages/send`, () => ({ id: 'r1' }));
    await runNode(
      'app.gmail',
      { resource: 'message', operation: 'reply', messageId: 'm1', message: '<p>Paid</p>' },
      items({}),
      {
        creds: gmailCreds,
        services: { http },
      },
    );
    const sent = http.requests[1].body as DataObject;
    expect(sent.threadId).toBe('t-m1');
    const mime = decodeRaw(sent.raw as string);
    expect(mime).toContain('To: Ada <ada@example.com>');
    expect(mime).toContain('Subject: Re: Invoice 7');
    expect(mime).toContain('In-Reply-To: <m1@example.com>');
    expect(mime).toContain('References: <m0@example.com> <m1@example.com>');
  });

  it('gets messages with attachments downloaded as binary data', async () => {
    const http = new FakeHttpClient()
      .on('GET', `${GMAIL}/messages/m1/attachments/att1`, () => ({ data: b64url('%PDF') }))
      .on('GET', `${GMAIL}/messages/m1`, () => gmailMessage('m1'));
    const r = await runNode(
      'app.gmail',
      { resource: 'message', operation: 'get', messageId: 'm1', options: { downloadAttachments: true } },
      items({}),
      { creds: gmailCreds, services: { http } },
    );
    expect(r.outputs[0][0]).toMatchObject({ id: 'm1', subject: 'Invoice 7' });
    expect(r.items[0][0].binary?.attachment_0).toMatchObject({
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
    });
    expect(Buffer.from(r.items[0][0].binary!.attachment_0.data, 'base64').toString()).toBe('%PDF');
  });

  it('lists messages with a search query and page tokens', async () => {
    const http = new FakeHttpClient()
      .on('GET', /\/messages\?/, (req) =>
        new URL(req.url).searchParams.get('pageToken')
          ? { messages: [{ id: 'm3' }] }
          : { messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'p2' },
      )
      .on('GET', /\/messages\/m\d/, (req) => gmailMessage(req.url.split('/messages/')[1].split('?')[0]));
    const r = await runNode(
      'app.gmail',
      {
        resource: 'message',
        operation: 'getAll',
        returnAll: true,
        filters: { q: 'has:attachment', readStatus: 'unread', sender: 'ada@example.com' },
      },
      items({}),
      { creds: gmailCreds, services: { http } },
    );
    expect(r.outputs[0].map((o) => o.id)).toEqual(['m1', 'm2', 'm3']);
    expect(new URL(http.requests[0].url).searchParams.get('q')).toBe(
      'has:attachment from:ada@example.com is:unread',
    );
  });

  it('modifies labels, read state, drafts and labels', async () => {
    const http = new FakeHttpClient()
      .on('POST', /\/modify$/, (req) => ({ id: 'm1', ...(req.body as DataObject) }))
      .on('DELETE', /\/(messages|drafts)\//, () => '')
      .on('POST', `${GMAIL}/drafts`, () => ({ id: 'd1', message: { id: 'm9' } }))
      .on('GET', `${GMAIL}/drafts/d1`, () => ({ id: 'd1', message: gmailMessage('m9') }))
      .on('GET', `${GMAIL}/labels`, () => ({
        labels: [
          { id: 'L1', name: 'Invoices' },
          { id: 'INBOX', name: 'INBOX' },
        ],
      }))
      .on('POST', `${GMAIL}/labels`, (req) => ({ id: 'L2', ...(req.body as DataObject) }));
    const call = (params: DataObject) =>
      runNode('app.gmail', params, items({}), { creds: gmailCreds, services: { http } });
    expect(
      (await call({ resource: 'message', operation: 'markRead', messageId: 'm1' })).outputs[0][0],
    ).toMatchObject({ removeLabelIds: ['UNREAD'] });
    expect(
      (await call({ resource: 'message', operation: 'markUnread', messageId: 'm1' })).outputs[0][0],
    ).toMatchObject({ addLabelIds: ['UNREAD'] });
    expect(
      (await call({ resource: 'message', operation: 'addLabels', messageId: 'm1', labelIds: ['L1'] }))
        .outputs[0][0],
    ).toMatchObject({ addLabelIds: ['L1'] });
    expect(
      (await call({ resource: 'message', operation: 'removeLabels', messageId: 'm1', labelIds: 'L1, L2' }))
        .outputs[0][0],
    ).toMatchObject({
      removeLabelIds: ['L1', 'L2'],
    });
    expect((await call({ resource: 'message', operation: 'delete', messageId: 'm1' })).outputs[0]).toEqual([
      { success: true, id: 'm1' },
    ]);
    const draft = await call({
      resource: 'draft',
      operation: 'create',
      subject: 'Hi',
      message: 'Body',
      options: { sendTo: 'x@example.com', threadId: 't9' },
    });
    expect(draft.outputs[0]).toEqual([{ id: 'd1', message: { id: 'm9' } }]);
    expect((http.requests.at(-1)!.body as DataObject).message).toMatchObject({ threadId: 't9' });
    expect((await call({ resource: 'draft', operation: 'get', draftId: 'd1' })).outputs[0][0]).toMatchObject({
      draftId: 'd1',
      id: 'm9',
      subject: 'Invoice 7',
    });
    expect((await call({ resource: 'draft', operation: 'delete', draftId: 'd1' })).outputs[0]).toEqual([
      { success: true, id: 'd1' },
    ]);
    expect((await call({ resource: 'label', operation: 'getAll', returnAll: true })).outputs[0]).toHaveLength(
      2,
    );
    expect(
      (await call({ resource: 'label', operation: 'create', name: 'Paid' })).outputs[0][0],
    ).toMatchObject({ id: 'L2', name: 'Paid', labelListVisibility: 'labelShow' });
    const ctx = contextFor('app.gmail', {}, { creds: gmailCreds, services: { http } });
    expect(await ctx.nodeType.methods!.loadOptions!.getLabels(ctx.loadOptions())).toEqual([
      { name: 'INBOX', value: 'INBOX' },
      { name: 'Invoices', value: 'L1' },
    ]);
  });

  it('requires a recipient and labels', async () => {
    const http = new FakeHttpClient();
    const r = await runNode('app.gmail', { resource: 'message', operation: 'send', sendTo: '' }, items({}), {
      creds: gmailCreds,
      services: { http },
    });
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/recipient/);
    expect(http.requests).toHaveLength(0);
  });
});

describe('Gmail Trigger', () => {
  it('emits new emails since the last poll and remembers them', async () => {
    let inbox = [gmailMessage('m1', { internalDate: String(Date.now() + 1000) })];
    const http = new FakeHttpClient()
      .on('GET', /\/messages\?/, () => ({ messages: inbox.map((m) => ({ id: m.id })) }))
      .on('GET', /\/messages\/m\d/, (req) => inbox.find((m) => req.url.includes(`/messages/${m.id}?`)));
    const staticData: DataObject = {};
    const ctx = contextFor(
      'app.gmailTrigger',
      { filters: { readStatus: 'unread' } },
      { creds: gmailCreds, services: { http }, staticData },
    );
    const trigger = ctx.nodeType;

    // first activation poll starts from "now": the message is newer, so it is emitted
    const first = await trigger.poll!(ctx.poll());
    expect(first?.[0].map((i) => i.json.id)).toEqual(['m1']);
    const state = staticData['node:Node'] as DataObject;
    expect(state.possibleDuplicates).toEqual(['m1']);
    expect(new URL(http.requests[0].url).searchParams.get('q')).toMatch(/is:unread after:\d+/);

    // the same message is not emitted twice
    expect(await trigger.poll!(ctx.poll())).toBeNull();

    // a newer message is emitted alone
    inbox = [...inbox, gmailMessage('m2', { internalDate: String(Date.now() + 5000) })];
    const third = await trigger.poll!(ctx.poll());
    expect(third?.[0].map((i) => i.json.id)).toEqual(['m2']);
  });

  it('returns the latest email on a manual test without touching the cursor', async () => {
    const http = new FakeHttpClient()
      .on('GET', /\/messages\?/, () => ({ messages: [{ id: 'm1' }] }))
      .on('GET', /\/messages\/m1/, () => gmailMessage('m1'));
    const staticData: DataObject = {};
    const ctx = contextFor('app.gmailTrigger', {}, { creds: gmailCreds, services: { http }, staticData });
    const result = await ctx.nodeType.poll!(ctx.poll('manual'));
    expect(result?.[0][0].json).toMatchObject({ id: 'm1', subject: 'Invoice 7' });
    expect(new URL(http.requests[0].url).searchParams.get('maxResults')).toBe('1');
    expect(staticData['node:Node']).toEqual({});
  });
});

describe('Google Sheets', () => {
  const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
  const doc = { __rl: true, mode: 'url', value: 'https://docs.google.com/spreadsheets/d/DOC1/edit#gid=0' };
  const sheet = { __rl: true, mode: 'name', value: "Bob's Sheet" };
  const grid = [['email', 'name', 'status'], ['ada@x', 'Ada', 'new'], ['bob@x', 'Bob', 'old'], []];

  function sheetsApi() {
    return new FakeHttpClient()
      .on('GET', `${SHEETS}/DOC1?`, () => ({
        sheets: [{ properties: { sheetId: 7, title: "Bob's Sheet" } }],
      }))
      .on('GET', `${SHEETS}/DOC1/values/`, () => ({ values: grid }))
      .on('PUT', `${SHEETS}/DOC1/values/`, () => ({}))
      .on('POST', `${SHEETS}/DOC1/values:batchUpdate`, () => ({ totalUpdatedRows: 1 }))
      .on('POST', /values\/.*:append/, () => ({ updates: { updatedRange: "'Bob''s Sheet'!A4:C5" } }))
      .on('POST', /values\/.*:clear/, () => ({ clearedRange: "'Bob''s Sheet'!A2:ZZZ" }))
      .on('POST', `${SHEETS}/DOC1:batchUpdate`, () => ({ replies: [{}] }))
      .on('POST', SHEETS, (req) => ({
        spreadsheetId: 'NEW',
        properties: (req.body as DataObject).properties,
      }));
  }
  const run = (params: DataObject, input: Item[], http: FakeHttpClient) =>
    runNode('app.googleSheets', { documentId: doc, sheetName: sheet, ...params }, input, {
      creds: sheetsCreds,
      services: { http },
    });

  it('has A1 helpers', () => {
    expect(columnLetter(1)).toBe('A');
    expect(columnLetter(28)).toBe('AB');
    expect(columnIndex('AB')).toBe(28);
    expect(quoteSheet("Bob's")).toBe("'Bob''s'");
  });

  it('reads rows with header mapping, row numbers and filters', async () => {
    const http = sheetsApi();
    const all = await run({ resource: 'sheet', operation: 'read' }, items({}), http);
    expect(all.outputs[0]).toEqual([
      { row_number: 2, email: 'ada@x', name: 'Ada', status: 'new' },
      { row_number: 3, email: 'bob@x', name: 'Bob', status: 'old' },
    ]);
    expect(decodeURIComponent(http.requests[1].url)).toContain("/values/'Bob''s Sheet'?");
    expect(http.requests[0].headers.authorization).toBe('Bearer ya29.sheets');
    const filtered = await run(
      {
        resource: 'sheet',
        operation: 'read',
        filtersUI: { values: [{ lookupColumn: 'status', lookupValue: 'old' }] },
      },
      items({}),
      http,
    );
    expect(filtered.outputs[0]).toEqual([{ row_number: 3, email: 'bob@x', name: 'Bob', status: 'old' }]);
    const badColumn = await run(
      {
        resource: 'sheet',
        operation: 'read',
        filtersUI: { values: [{ lookupColumn: 'nope', lookupValue: 1 }] },
      },
      items({}),
      http,
    );
    expect(badColumn.status).toBe('error');
  });

  it('appends all items in one request and adds new columns', async () => {
    const http = sheetsApi();
    const r = await run(
      { resource: 'sheet', operation: 'append' },
      items({ email: 'cy@x', name: 'Cy', vip: true }, { email: 'di@x', tags: ['a'] }),
      http,
    );
    expect(r.outputs[0]).toEqual([
      { email: 'cy@x', name: 'Cy', vip: true, row_number: 4 },
      { email: 'di@x', tags: ['a'], row_number: 5 },
    ]);
    expect(decodeURIComponent(http.requests[1].url)).toContain("/values/'Bob''s Sheet'!1:1?");
    const header = http.requests.find((q) => q.method === 'PUT')!;
    expect((header.body as DataObject).values).toEqual([['email', 'name', 'status', 'vip', 'tags']]);
    const append = http.requests.filter((q) => q.url.includes(':append'));
    expect(append).toHaveLength(1);
    expect((append[0].body as DataObject).values).toEqual([
      ['cy@x', 'Cy', '', true, ''],
      ['di@x', '', '', '', '["a"]'],
    ]);
    expect(new URL(append[0].url).searchParams.get('valueInputOption')).toBe('USER_ENTERED');
  });

  it('updates matching rows, and appends unmatched ones with append-or-update', async () => {
    const http = sheetsApi();
    const updated = await run(
      {
        resource: 'sheet',
        operation: 'update',
        columnToMatchOn: 'email',
        dataMode: 'defineBelow',
        fieldsUi: {
          values: [
            { column: 'email', fieldValue: '={{ $json.e }}' },
            { column: 'status', fieldValue: 'paid' },
          ],
        },
      },
      items({ e: 'bob@x' }, { e: 'nobody@x' }),
      http,
    );
    expect(updated.outputs[0]).toEqual([
      { email: 'bob@x', status: 'paid', row_number: 3 },
      { email: 'nobody@x', status: 'paid' },
    ]);
    const batch = http.requests.find((q) => q.url.endsWith('values:batchUpdate'))!;
    expect((batch.body as DataObject).data).toEqual([
      { range: "'Bob''s Sheet'!A3", values: [['bob@x']] },
      { range: "'Bob''s Sheet'!C3", values: [['paid']] },
    ]);

    const http2 = sheetsApi();
    await run(
      { resource: 'sheet', operation: 'appendOrUpdate', columnToMatchOn: 'email' },
      items({ email: 'ada@x', status: 'vip' }, { email: 'new@x' }),
      http2,
    );
    expect(http2.requests.filter((q) => q.url.endsWith('values:batchUpdate'))).toHaveLength(1);
    expect((http2.requests.find((q) => q.url.includes(':append'))!.body as DataObject).values).toEqual([
      ['new@x', '', ''],
    ]);
  });

  it('writes only the provided columns, one range per contiguous run', async () => {
    const http = sheetsApi();
    await run(
      { resource: 'sheet', operation: 'update', columnToMatchOn: 'email' },
      items({ email: 'bob@x', name: 'Robert', status: 'paid' }, { email: 'ada@x', name: 'Ada B' }),
      http,
    );
    const batch = http.requests.find((q) => q.url.endsWith('values:batchUpdate'))!;
    expect((batch.body as DataObject).data).toEqual([
      { range: "'Bob''s Sheet'!A3:C3", values: [['bob@x', 'Robert', 'paid']] },
      { range: "'Bob''s Sheet'!A2:B2", values: [['ada@x', 'Ada B']] },
    ]);
  });

  it('reports missing match values per item', async () => {
    const http = sheetsApi();
    const r = await run(
      { resource: 'sheet', operation: 'update', columnToMatchOn: 'email' },
      items({ name: 'no email' }),
      http,
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/no value for the match column "email"/);
  });

  it('clears, deletes rows or columns, creates spreadsheets and lists sheets', async () => {
    const http = sheetsApi();
    const cleared = await run({ resource: 'sheet', operation: 'clear', keepFirstRow: true }, items({}), http);
    expect(cleared.outputs[0][0]).toMatchObject({ spreadsheetId: 'DOC1' });
    expect(decodeURIComponent(http.requests.at(-1)!.url)).toContain("'Bob''s Sheet'!A2:ZZZ:clear");
    await run(
      { resource: 'sheet', operation: 'delete', toDelete: 'columns', startColumn: 'B', numberToDelete: 2 },
      items({}),
      http,
    );
    expect(http.requests.at(-1)!.body).toEqual({
      requests: [
        { deleteDimension: { range: { sheetId: 7, dimension: 'COLUMNS', startIndex: 1, endIndex: 3 } } },
      ],
    });
    await run({ resource: 'sheet', operation: 'delete', startIndex: 5 }, items({}), http);
    expect((http.requests.at(-1)!.body as DataObject).requests).toEqual([
      { deleteDimension: { range: { sheetId: 7, dimension: 'ROWS', startIndex: 4, endIndex: 5 } } },
    ]);
    const created = await runNode(
      'app.googleSheets',
      {
        resource: 'spreadsheet',
        operation: 'create',
        title: 'Report',
        sheetsUi: { sheetValues: [{ title: 'Q1' }] },
      },
      items({}),
      {
        creds: sheetsCreds,
        services: { http },
      },
    );
    expect(created.outputs[0][0]).toMatchObject({ spreadsheetId: 'NEW' });
    expect(http.requests.at(-1)!.body).toEqual({
      properties: { title: 'Report' },
      sheets: [{ properties: { title: 'Q1' } }],
    });
    const listed = await runNode(
      'app.googleSheets',
      { resource: 'spreadsheet', operation: 'listSheets', documentId: doc },
      items({}),
      {
        creds: sheetsCreds,
        services: { http },
      },
    );
    expect(listed.outputs[0]).toEqual([{ sheetId: 7, title: "Bob's Sheet" }]);
  });

  it('fails clearly for unknown sheets', async () => {
    const http = sheetsApi();
    const r = await run(
      { resource: 'sheet', operation: 'read', sheetName: { __rl: true, mode: 'name', value: 'Nope' } },
      items({}),
      http,
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/Sheet "Nope" was not found/);
  });

  it('searches spreadsheets and sheets, and loads columns', async () => {
    const http = sheetsApi().on('GET', 'https://www.googleapis.com/drive/v3/files', () => ({
      files: [{ id: 'DOC1', name: 'Leads', webViewLink: 'https://docs.google.com/spreadsheets/d/DOC1' }],
      nextPageToken: 'p2',
    }));
    const ctx = contextFor(
      'app.googleSheets',
      { documentId: doc, sheetName: { __rl: true, mode: 'list', value: '7' } },
      { creds: sheetsCreds, services: { http } },
    );
    const docs = await ctx.nodeType.methods!.listSearch!.searchSpreadsheets(ctx.loadOptions(), "Q'4");
    expect(docs.results[0]).toEqual({
      name: 'Leads',
      value: 'DOC1',
      url: 'https://docs.google.com/spreadsheets/d/DOC1',
    });
    expect(new URL(http.requests[0].url).searchParams.get('q')).toContain("name contains 'Q\\'4'");
    const sheets = await ctx.nodeType.methods!.listSearch!.searchSheets(ctx.loadOptions());
    expect(sheets.results).toEqual([
      { name: "Bob's Sheet", value: '7', url: 'https://docs.google.com/spreadsheets/d/DOC1/edit#gid=7' },
    ]);
    const columns = await ctx.nodeType.methods!.loadOptions!.getSheetColumns(ctx.loadOptions());
    expect(columns.map((c) => c.value)).toEqual(['email', 'name', 'status']);
  });
});
