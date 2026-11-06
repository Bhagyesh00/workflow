/** P4-17: Send and Wait for Response on Send Email, Gmail, Slack and Telegram, and the answers. */
import type { DataObject, Item, WebhookResponseData } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contextFor } from './contexts';
import { FakeHttpClient, runNode } from './harness';
import { localHttp, startSmtpServer } from './servers';

const RESUME = 'http://localhost:5678/webhook-waiting/e1/sig';
const services = (extra: object = {}) => ({ resumeUrl: RESUME, ...extra });
const input: Item[] = [{ json: { id: 7 } }];

const NODES = ['core.sendEmail', 'app.gmail', 'app.slack', 'app.telegram'] as const;

/** a node's own settings plus the shared ones */
const base: Record<(typeof NODES)[number], DataObject> = {
  'core.sendEmail': { operation: 'sendAndWait', fromEmail: 'a@example.com', toEmail: 'b@example.com' },
  'app.gmail': { resource: 'message', operation: 'sendAndWait', sendTo: 'b@example.com', subject: 'Review' },
  'app.slack': {
    resource: 'message',
    operation: 'sendAndWait',
    select: 'channel',
    channelId: { __rl: true, mode: 'id', value: 'C123' },
  },
  'app.telegram': { resource: 'message', operation: 'sendAndWait', chatId: '42' },
};

const body = (data: WebhookResponseData) => (data.webhookResponse?.body ?? '') as string;

describe('descriptions', () => {
  it.each(NODES)('%s offers the operation and resume hooks on the signed URL', (name) => {
    const { description } = contextFor(name, base[name]).nodeType;
    const operation = description.properties.find(
      (p) => p.name === 'operation' && JSON.stringify(p.options).includes('sendAndWait'),
    );
    expect(operation).toBeDefined();
    const hooks = (description.webhooks ?? []).filter((h) => h.restartWebhook);
    expect(hooks.map((h) => h.httpMethod).sort()).toEqual(['GET', 'POST']);
    // plain /webhook-waiting hooks, not the form family
    expect(hooks.every((h) => h.nodeType === undefined && h.responseMode === 'onReceived')).toBe(true);
    for (const property of ['message', 'responseType', 'approvalOptions', 'formFields', 'options']) {
      expect(description.properties.some((p) => p.name === property)).toBe(true);
    }
  });

  it('Send Email keeps sending by default', async () => {
    const smtp = await startSmtpServer();
    try {
      const r = await runNode(
        'core.sendEmail',
        {
          fromEmail: 'a@example.com',
          toEmail: 'b@example.com',
          subject: 'Hi',
          emailFormat: 'text',
          text: 'Hello',
        },
        input,
        {
          creds: { smtp: { host: '127.0.0.1', port: smtp.port, secure: false, user: 'u', password: 'p' } },
          services: { http: localHttp() },
        },
      );
      expect(r.error?.message).toBeUndefined();
      expect(r.status).toBe('success');
      expect(smtp.messages).toHaveLength(1);
    } finally {
      await smtp.close();
    }
  });
});

describe('Slack', () => {
  const slack = () =>
    new FakeHttpClient().on('*', /^https:\/\/slack\.com\/api\/chat\.postMessage/, () => ({
      ok: true,
      channel: 'C123',
      ts: '1.2',
    }));
  const creds = { slackApi: { accessToken: 'xoxb-test' } };

  it('posts the message with approve and decline link buttons, and waits', async () => {
    const http = slack();
    const r = await runNode(
      'app.slack',
      {
        ...base['app.slack'],
        message: '=Order {{ $json.id }} needs <approval> & more',
        approvalOptions: {
          values: {
            approvalType: 'double',
            approveLabel: 'Ship it',
            buttonApprovalStyle: 'primary',
            disapproveLabel: 'Stop',
            buttonDisapprovalStyle: 'secondary',
          },
        },
      },
      input,
      { creds, services: services({ http }) },
    );
    expect(r.status).toBe('waiting');
    expect(new Date(r.result.state.waitTill as string).getFullYear()).toBe(3000);
    const sent = http.requests[0].body as DataObject;
    expect(sent.channel).toBe('C123');
    const [section, actions] = sent.blocks as DataObject[];
    expect(section).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: 'Order 7 needs &lt;approval&gt; &amp; more' },
    });
    expect(
      (actions.elements as DataObject[]).map((e) => [(e.text as DataObject).text, e.url, e.style]),
    ).toEqual([
      ['Ship it', `${RESUME}?approved=true`, 'primary'],
      ['Stop', `${RESUME}?approved=false`, undefined],
    ]);
  });

  it('sends nothing when the run has no resume URL', async () => {
    const http = slack();
    const r = await runNode('app.slack', { ...base['app.slack'], message: 'Hi' }, input, {
      creds,
      services: { http, resumeUrl: undefined },
    });
    expect(r.status).toBe('error');
    expect(http.requests).toHaveLength(0);
  });

  it('refuses an empty message before sending', async () => {
    const http = slack();
    const r = await runNode('app.slack', { ...base['app.slack'], message: '  ' }, input, {
      creds,
      services: services({ http }),
    });
    expect(r.error?.message).toBe('The message is empty');
    expect(http.requests).toHaveLength(0);
  });

  it('a direct message goes to the user', async () => {
    const http = slack();
    await runNode(
      'app.slack',
      {
        ...base['app.slack'],
        select: 'user',
        user: { __rl: true, mode: 'id', value: 'U9' },
        message: 'Hi',
      },
      input,
      { creds, services: services({ http }) },
    );
    expect((http.requests[0].body as DataObject).channel).toBe('U9');
  });

  it('ordinary send is unchanged', async () => {
    const http = slack();
    const r = await runNode(
      'app.slack',
      {
        resource: 'message',
        operation: 'send',
        channelId: { __rl: true, mode: 'id', value: 'C123' },
        text: 'x',
      },
      input,
      { creds, services: services({ http }) },
    );
    expect(r.status).toBe('success');
  });
});

describe('Telegram', () => {
  const TOKEN = '123:abc';
  const API = `https://api.telegram.org/bot${TOKEN}`;
  const creds = { telegramApi: { accessToken: TOKEN, baseUrl: 'https://api.telegram.org' } };
  const telegram = () =>
    new FakeHttpClient().on('POST', API, () => ({ ok: true, result: { message_id: 1 } }));

  it('sends link buttons under the message and waits', async () => {
    const http = telegram();
    const r = await runNode(
      'app.telegram',
      {
        ...base['app.telegram'],
        message: 'Approve the invoice?',
        approvalOptions: { values: { approvalType: 'double' } },
      },
      input,
      { creds, services: services({ http }) },
    );
    expect(r.status).toBe('waiting');
    expect(http.requests[0].url).toBe(`${API}/sendMessage`);
    expect(http.requests[0].body).toEqual({
      chat_id: '42',
      text: 'Approve the invoice?',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Approve', url: `${RESUME}?approved=true` },
            { text: 'Decline', url: `${RESUME}?approved=false` },
          ],
        ],
      },
    });
  });

  it('Free Text and Custom Form send one button to the page', async () => {
    for (const responseType of ['freeText', 'customForm']) {
      const http = telegram();
      const r = await runNode(
        'app.telegram',
        {
          ...base['app.telegram'],
          message: 'Tell us',
          responseType,
          formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] },
          options: { messageButtonLabel: 'Open form' },
        },
        input,
        { creds, services: services({ http }) },
      );
      expect(r.status).toBe('waiting');
      expect((http.requests[0].body as DataObject).reply_markup).toEqual({
        inline_keyboard: [[{ text: 'Open form', url: RESUME }]],
      });
    }
  });

  it('a Custom Form with no elements stops before sending', async () => {
    const http = telegram();
    const r = await runNode(
      'app.telegram',
      { ...base['app.telegram'], message: 'Tell us', responseType: 'customForm' },
      input,
      { creds, services: services({ http }) },
    );
    expect(r.error?.message).toBe('Add at least one form element to the custom form');
    expect(http.requests).toHaveLength(0);
  });

  it('Limit Wait Time sets when the wait ends, After Time Interval and At Specified Time', async () => {
    const run = (limitWaitTime: DataObject) =>
      runNode('app.telegram', { ...base['app.telegram'], message: 'Hi', options: { limitWaitTime } }, input, {
        creds,
        services: services({ http: telegram() }),
      });
    const timed = await run({
      values: { limitType: 'afterTimeInterval', resumeAmount: 2, resumeUnit: 'hours' },
    });
    const left = new Date(timed.result.state.waitTill as string).getTime() - Date.now();
    expect(left).toBeGreaterThan(3_600_000);
    expect(left).toBeLessThanOrEqual(7_200_000);
    const dated = await run({
      values: { limitType: 'atSpecifiedTime', maxDateAndTime: '2999-01-01T00:00:00Z' },
    });
    expect(new Date(dated.result.state.waitTill as string).getUTCFullYear()).toBe(2999);
    const bad = await run({ values: { limitType: 'atSpecifiedTime', maxDateAndTime: 'nonsense' } });
    expect(bad.status).toBe('error');
  });
});

describe('Gmail', () => {
  it('sends a MIME message with the buttons as links and waits', async () => {
    const http = new FakeHttpClient().on('POST', /\/messages\/send$/, () => ({ id: 'm1' }));
    const r = await runNode(
      'app.gmail',
      {
        ...base['app.gmail'],
        message: 'Please <b>review</b>',
        approvalOptions: { values: { approvalType: 'single' } },
      },
      input,
      {
        creds: { gmailOAuth2: { oauthTokenData: { access_token: 'ya29.gmail' } } },
        services: services({ http }),
      },
    );
    expect(r.error?.message).toBeUndefined();
    expect(r.status).toBe('waiting');
    const raw = (http.requests[0].body as DataObject).raw as string;
    const mime = Buffer.from(raw, 'base64url').toString('utf8');
    expect(mime).toContain('To: b@example.com');
    expect(mime).toContain('Subject: Review');
    const parts = [...mime.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)(?:\r\n--|$)/g)].map(
      (m) => Buffer.from(m[1].replace(/\s/g, ''), 'base64').toString('utf8'),
    );
    const html = parts.find((p) => p.includes('<a ')) ?? '';
    expect(html).toContain(`href="${RESUME}?approved=true"`);
    expect(html).toContain('Please &lt;b&gt;review&lt;/b&gt;');
    expect(parts.some((p) => p.includes(`Approve: ${RESUME}?approved=true`))).toBe(true);
  });
});

describe('Send Email', () => {
  let smtp: Awaited<ReturnType<typeof startSmtpServer>>;
  beforeAll(async () => {
    smtp = await startSmtpServer();
  });
  afterAll(async () => {
    await smtp.close();
  });

  it('mails the buttons as links, as HTML and as text, and waits', async () => {
    const r = await runNode(
      'core.sendEmail',
      {
        ...base['core.sendEmail'],
        subject: 'Please approve\r\nBcc: x@example.com',
        message: 'Line one\nLine "two"',
      },
      input,
      {
        creds: { smtp: { host: '127.0.0.1', port: smtp.port, secure: false, user: 'u', password: 'p' } },
        services: services({ http: localHttp() }),
      },
    );
    expect(r.status).toBe('waiting');
    const data = smtp.messages.at(-1)!.data;
    const decoded = data
      .replace(/=\r\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    expect(decoded).toContain(`href="${RESUME}?approved=true"`);
    expect(decoded).toContain(`Approve: ${RESUME}?approved=true`);
    expect(decoded).toContain('Line &quot;two&quot;');
    expect(data).not.toMatch(/^Bcc:/m);
  });
});

describe('the answers', () => {
  const answer = (
    name: (typeof NODES)[number],
    parameters: DataObject,
    request: { method?: string; query?: DataObject; body?: DataObject; headers?: Record<string, string> },
  ): Promise<WebhookResponseData> => {
    const { nodeType, webhook } = contextFor(name, { ...base[name], ...parameters });
    return nodeType.webhook!(
      webhook({
        method: request.method ?? 'GET',
        query: request.query,
        body: request.body,
        headers: request.headers ?? {},
      }),
    );
  };

  describe.each(NODES)('%s approval', (name) => {
    it('?approved=true resumes the run with the answer and thanks the person', async () => {
      const result = await answer(name, { message: 'Ok?' }, { query: { approved: 'true' } });
      expect(result.workflowData).toEqual([[{ json: { data: { approved: true } } }]]);
      expect(result.webhookResponse?.statusCode).toBe(200);
      expect(body(result)).toContain('Your response has been recorded');
    });

    it('?approved=false resumes with false', async () => {
      const result = await answer(name, { message: 'Ok?' }, { query: { approved: 'false' } });
      expect(result.workflowData).toEqual([[{ json: { data: { approved: false } } }]]);
    });

    it('a link without an answer, a made-up answer or a POST resumes nothing', async () => {
      for (const request of [
        { query: {} },
        { query: { approved: 'yes' } },
        { method: 'POST', query: { approved: 'true' }, body: { approved: 'true' } },
      ]) {
        const result = await answer(name, { message: 'Ok?' }, request);
        expect(result.workflowData).toBeUndefined();
        expect(result.webhookResponse?.statusCode).toBe(400);
      }
    });

    it('a mail scanner or link preview opening the link resumes nothing', async () => {
      for (const agent of [
        'Mozilla/5.0 (compatible; Googlebot/2.1)',
        'Slackbot-LinkExpanding 1.0',
        'link preview',
      ]) {
        const result = await answer(
          name,
          { message: 'Ok?' },
          { query: { approved: 'true' }, headers: { 'user-agent': agent } },
        );
        expect(result.workflowData).toBeUndefined();
        expect(result.webhookResponse?.statusCode).toBe(200);
      }
    });
  });

  it('does nothing for a node that is not waiting for a response', async () => {
    const result = await answer(
      'app.telegram',
      { resource: 'message', operation: 'sendMessage', text: 'x' },
      { query: { approved: 'true' } },
    );
    expect(result.workflowData).toBeUndefined();
    expect(result.webhookResponse?.statusCode).toBe(404);
  });

  describe('Free Text', () => {
    const parameters = { message: 'What is <b>your</b> name?\nAnd why?', responseType: 'freeText' };

    it.each(NODES)('%s: GET shows the message and a text box, and resumes nothing', async (name) => {
      const result = await answer(name, parameters, {});
      expect(result.workflowData).toBeUndefined();
      const page = body(result);
      expect(result.webhookResponse?.headers?.['content-type']).toContain('text/html');
      expect(page).toContain('What is &lt;b&gt;your&lt;/b&gt; name?<br />And why?');
      expect(page).toContain('<textarea');
      expect(page).toContain('Submit');
    });

    it('uses the page options', async () => {
      const result = await answer(
        'app.slack',
        {
          ...parameters,
          options: {
            responseFormTitle: 'Quick question',
            responseFormDescription: '<em>Be brief</em><script>alert(1)</script>',
            responseFormButtonLabel: 'Send it',
          },
        },
        {},
      );
      const page = body(result);
      expect(page).toContain('<title>Quick question</title>');
      expect(page).toContain('<em>Be brief</em>');
      expect(page).not.toContain('alert(1)');
      expect(page).toContain('Send it');
    });

    it.each(NODES)('%s: POST resumes with the text', async (name) => {
      const result = await answer(name, parameters, { method: 'POST', body: { 'field-0': '  Ada  ' } });
      expect(result.workflowData).toEqual([[{ json: { data: { text: 'Ada' } } }]]);
      expect(result.webhookResponse?.body).toEqual({ formSubmittedText: 'Your response has been recorded' });
    });

    it('an empty text resumes nothing', async () => {
      const result = await answer('app.slack', parameters, { method: 'POST', body: { 'field-0': '   ' } });
      expect(result.workflowData).toBeUndefined();
      expect(result.webhookResponse?.statusCode).toBe(400);
    });

    it('a text that holds {{ }} stays text', async () => {
      const result = await answer('app.slack', parameters, {
        method: 'POST',
        body: { 'field-0': '{{ 1 + 1 }} $& $1' },
      });
      expect(result.workflowData).toEqual([[{ json: { data: { text: '{{ 1 + 1 }} $& $1' } } }]]);
    });
  });

  describe('Custom Form', () => {
    const fields = [
      { fieldLabel: 'Name', fieldType: 'text', requiredField: true },
      { fieldLabel: 'Age', fieldName: 'age', fieldType: 'number' },
      {
        fieldLabel: 'Tools',
        fieldType: 'checkbox',
        fieldOptions: { values: [{ option: 'a' }, { option: 'b' }] },
      },
      {
        fieldLabel: 'Pick',
        fieldType: 'radio',
        fieldOptions: { values: [{ option: 'x' }, { option: 'y' }] },
      },
      { fieldLabel: 'Note', fieldType: 'textarea' },
    ];
    const parameters = {
      message: 'Details please',
      responseType: 'customForm',
      formFields: { values: fields },
    };

    it.each(NODES)('%s: GET shows the elements under the message', async (name) => {
      const page = body(await answer(name, parameters, {}));
      expect(page).toContain('Details please');
      for (const label of ['Name', 'Age', 'Tools', 'Pick', 'Note']) expect(page).toContain(label);
      expect(page).toContain('type="checkbox"');
    });

    it('POST resumes with the answers of each element', async () => {
      const result = await answer('app.telegram', parameters, {
        method: 'POST',
        body: { 'field-0': ' Ann ', 'field-1': '42', 'field-2': ['a', 'b'], 'field-3': 'y', 'field-4': 'hi' },
      });
      expect(result.workflowData).toEqual([
        [{ json: { data: { Name: 'Ann', age: 42, Tools: ['a', 'b'], Pick: 'y', Note: 'hi' } } }],
      ]);
      expect(result.webhookResponse?.body).toEqual({ formSubmittedText: 'Your response has been recorded' });
    });

    it('a required element left empty resumes nothing', async () => {
      const result = await answer('app.telegram', parameters, { method: 'POST', body: { 'field-0': '  ' } });
      expect(result.workflowData).toBeUndefined();
      expect(result.webhookResponse?.statusCode).toBe(400);
      expect(result.webhookResponse?.body).toEqual({ message: 'Name is required' });
    });

    it('reads the elements from JSON', async () => {
      const result = await answer(
        'app.gmail',
        {
          message: 'Details',
          responseType: 'customForm',
          defineForm: 'json',
          jsonOutput: JSON.stringify([{ fieldLabel: 'City', fieldType: 'text' }]),
        },
        { method: 'POST', body: { 'field-0': 'Pune' } },
      );
      expect(result.workflowData).toEqual([[{ json: { data: { City: 'Pune' } } }]]);
    });

    it('never writes names that would reach the prototype', async () => {
      const result = await answer(
        'app.gmail',
        {
          message: 'Details',
          responseType: 'customForm',
          formFields: {
            values: [
              { fieldLabel: '__proto__', fieldType: 'text' },
              { fieldLabel: 'ok', fieldType: 'text' },
            ],
          },
        },
        { method: 'POST', body: { 'field-0': 'x', 'field-1': 'y' } },
      );
      const data = (result.workflowData?.[0]?.[0]?.json as DataObject).data as DataObject;
      expect(Object.keys(data)).toEqual(['ok']);
      expect(({} as DataObject).x).toBeUndefined();
    });

    it('a page value that holds {{ }} is shown as it is written', async () => {
      const page = body(
        await answer(
          'app.gmail',
          {
            message: 'Hello {{ 1 + 1 }}',
            responseType: 'customForm',
            formFields: { values: [{ fieldLabel: '<i>L</i>', fieldType: 'text' }] },
          },
          {},
        ),
      );
      expect(page).toContain('Hello {{ 1 + 1 }}');
      expect(page).toContain('&lt;i&gt;L&lt;/i&gt;');
    });
  });
});
