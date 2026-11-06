/** P4-01: the Form Trigger's webhook, page, output and access checks through a real webhook context. */
import { createWebhookContext, type ExecutionServices } from '@workflow/core';
import {
  type Connections,
  type DataObject,
  ExpressionEvaluator,
  type WebhookRequest,
  type WebhookResponseData,
  Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ipAllowed } from '../src/nodes/core/form/access';
import { renderMessagePage } from '../src/nodes/core/form/render';
import { safeRedirectUrl, sanitizeCustomCss, sanitizeHtml } from '../src/nodes/core/form/sanitize';
import { checkFormUserAuth } from '../src/nodes/core/form/user-auth';
import { connect, node, nodeTypes, testServices } from './harness';

vi.mock('../src/nodes/core/form/user-auth', () => ({
  userAuthProperties: [],
  checkFormUserAuth: vi.fn(),
}));

/** a signer with the service's contract: the payload back, or null when forged or expired */
const fakeTokens = () => {
  const issued = new Map<string, { payload: DataObject; expires: number }>();
  return {
    sign(payload: DataObject, ttlSeconds: number) {
      const token = `tok-${issued.size + 1}`;
      issued.set(token, { payload, expires: Date.now() + ttlSeconds * 1000 });
      return token;
    },
    verify(token: string) {
      const found = issued.get(token);
      return found && found.expires > Date.now() ? found.payload : null;
    },
  };
};

interface CallOptions {
  method?: 'GET' | 'POST';
  query?: DataObject;
  body?: DataObject;
  headers?: WebhookRequest['headers'];
  ip?: string;
  files?: WebhookRequest['files'];
  mode?: 'manual' | 'webhook';
  creds?: Record<string, DataObject>;
  services?: Partial<ExecutionServices>;
  /** other nodes of the workflow, connected with `connections` */
  nodes?: WorkflowNode[];
  connections?: Connections;
  timezone?: string;
}

async function call(parameters: DataObject, options: CallOptions = {}): Promise<WebhookResponseData> {
  const method = options.method ?? 'GET';
  const workflow = new Workflow(
    {
      id: 'wf-1',
      name: 'forms',
      nodes: [
        node('Form', 'core.formTrigger', parameters, [0, 0], {
          credentials: options.creds ? { httpBasicAuth: { id: 'c1', name: 'Login' } } : undefined,
        }),
        ...(options.nodes ?? []),
      ],
      connections: options.connections ?? {},
      settings: options.timezone ? { timezone: options.timezone } : {},
    },
    nodeTypes,
  );
  const ctx = createWebhookContext(
    {
      workflow,
      node: workflow.nodes.Form,
      services: testServices(options.creds ?? {}, {
        mode: options.mode ?? 'webhook',
        formTokens: fakeTokens(),
        ...options.services,
      }),
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    },
    {
      method,
      headers: options.headers ?? {},
      query: options.query ?? {},
      params: {},
      body: options.body ?? {},
      ip: options.ip,
      files: options.files,
    },
    method === 'GET' ? 'setup' : 'default',
  );
  return nodeTypes.get('core.formTrigger')!.webhook!(ctx);
}

const page = async (parameters: DataObject, options: CallOptions = {}) => {
  const result = await call(parameters, options);
  expect(result.workflowData).toBeUndefined();
  return String(result.webhookResponse?.body);
};

const submit = async (parameters: DataObject, options: CallOptions = {}) => {
  const result = await call(parameters, { method: 'POST', ...options });
  return {
    result,
    json: result.workflowData?.[0]?.[0]?.json as DataObject,
    item: result.workflowData?.[0]?.[0],
  };
};

const fields = (...values: DataObject[]) => ({ formFields: { values } });
const basicHeader = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const BASIC_CREDS = { httpBasicAuth: { user: 'ann', password: 'secret' } };
const userAuth = vi.mocked(checkFormUserAuth);

afterEach(() => {
  userAuth.mockReset();
});

describe('Form Trigger description', () => {
  const description = nodeTypes.get('core.formTrigger')!.description;
  const property = (name: string) => description.properties.find((p) => p.name === name);
  const fieldValues = () => {
    const formFields = property('formFields')!;
    return (
      formFields.options![0] as { values: Array<{ name: string; default?: unknown; options?: unknown[] }> }
    ).values;
  };

  it('offers the 12 field types', () => {
    const type = fieldValues().find((p) => p.name === 'fieldType')!;
    expect((type.options as Array<{ value: string }>).map((o) => o.value).sort()).toEqual(
      [
        'checkbox',
        'date',
        'dropdown',
        'email',
        'file',
        'hiddenField',
        'html',
        'number',
        'password',
        'radio',
        'text',
        'textarea',
      ].sort(),
    );
  });

  it("has n8n's respond options, without Using Respond to Webhook", () => {
    const responseMode = property('responseMode')!;
    expect(responseMode.default).toBe('onReceived');
    expect((responseMode.options as Array<{ value: string }>).map((o) => o.value)).toEqual([
      'onReceived',
      'lastNode',
    ]);
  });

  it('has the options with their defaults', () => {
    const options = property('options')!.options as Array<{ name: string; default: unknown }>;
    const byName = Object.fromEntries(options.map((o) => [o.name, o.default]));
    expect(byName.buttonLabel).toBe('Submit');
    expect(byName.useWorkflowTimezone).toBe(true);
    expect(byName.showHeaders).toBe(false);
    expect(byName.ignoreBots).toBe(false);
    expect(byName.path).toBe('');
    expect(Object.keys(byName)).toEqual(
      expect.arrayContaining(['ipWhitelist', 'customCss', 'respondWithOptions', 'appendAttribution']),
    );
  });

  it('asks for the Basic Auth credential only on that option', () => {
    expect(description.credentials).toEqual([
      expect.objectContaining({
        name: 'httpBasicAuth',
        displayOptions: { show: { authentication: ['basicAuth'] } },
      }),
    ]);
  });
});

describe('form page', () => {
  it('renders every field type', async () => {
    const html = await page({
      formTitle: 'Sign up',
      ...fields(
        { fieldLabel: 'Name', fieldType: 'text', placeholder: 'Your name', requiredField: true },
        { fieldLabel: 'Bio', fieldType: 'textarea' },
        { fieldLabel: 'Age', fieldType: 'number' },
        { fieldLabel: 'Mail', fieldType: 'email' },
        { fieldLabel: 'Secret', fieldType: 'password' },
        { fieldLabel: 'Born', fieldType: 'date' },
        {
          fieldLabel: 'Color',
          fieldType: 'dropdown',
          fieldOptions: { values: [{ option: 'Red' }, { option: 'Blue' }] },
        },
        {
          fieldLabel: 'Size',
          fieldType: 'radio',
          fieldOptions: { values: [{ option: 'S' }, { option: 'L' }] },
        },
        {
          fieldLabel: 'Tags',
          fieldType: 'checkbox',
          fieldOptions: { values: [{ option: 'A' }, { option: 'B' }] },
          limitSelection: 'exact',
          numberOfSelections: 1,
        },
        { fieldLabel: 'Doc', fieldType: 'file', acceptFileTypes: '.pdf,.png', multipleFiles: false },
        { fieldType: 'hiddenField', fieldName: 'source', fieldValue: 'site' },
        { fieldType: 'html', html: '<p>Terms</p>' },
      ),
    });
    expect(html).toContain('<title>Sign up</title>');
    expect(html).toMatch(/<input[^>]*type="text"[^>]*name="field-0"[^>]*placeholder="Your name"/);
    expect(html).toMatch(/<textarea[^>]*name="field-1"/);
    expect(html).toMatch(/<input[^>]*type="number"[^>]*name="field-2"/);
    expect(html).toMatch(/<input[^>]*type="email"[^>]*name="field-3"/);
    expect(html).toMatch(/<input[^>]*type="password"[^>]*name="field-4"/);
    expect(html).toMatch(/<input[^>]*type="date"[^>]*name="field-5"/);
    expect(html).toMatch(/<select[^>]*name="field-6"/);
    expect(html).toContain('<option value="Blue"');
    expect(html).toMatch(/<input[^>]*type="radio"[^>]*name="field-7"[^>]*value="L"/);
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*name="field-8"[^>]*value="B"/);
    expect(html).toContain('data-min="1" data-max="1"');
    expect(html).toMatch(/<input[^>]*type="file"[^>]*name="field-9"[^>]*accept=".pdf,.png"/);
    expect(html).not.toMatch(/name="field-9"[^>]*multiple/);
    expect(html).toMatch(/<input[^>]*type="hidden"[^>]*name="field-10"[^>]*value="site"/);
    expect(html).toContain('<p>Terms</p>');
  });

  it('answers HTML that the browser must not cache', async () => {
    const { webhookResponse } = await call({ formTitle: 'T' });
    expect(webhookResponse?.statusCode).toBe(200);
    expect(webhookResponse?.headers?.['content-type']).toBe('text/html; charset=utf-8');
    expect(webhookResponse?.headers?.['cache-control']).toBe('no-store');
  });

  it('labels the button, Submit by default', async () => {
    expect(await page({ formTitle: 'T' })).toContain('>Submit</button>');
    expect(await page({ formTitle: 'T', options: { buttonLabel: 'Send <it>' } })).toContain(
      '>Send &lt;it&gt;</button>',
    );
  });

  it('escapes every value it writes', async () => {
    const evil = '"><script>alert(1)</script>';
    const html = await page({
      formTitle: evil,
      ...fields(
        {
          fieldLabel: evil,
          fieldType: 'text',
          placeholder: evil,
          defaultValue: evil,
        },
        { fieldLabel: 'Pick', fieldType: 'dropdown', fieldOptions: { values: [{ option: evil }] } },
      ),
      options: { buttonLabel: evil },
    });
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('keeps `<` out of the page config, so a value cannot close the script', async () => {
    const evil = '</script><script>alert(1)</script>';
    const html = await page({
      formTitle: 'T',
      options: { respondWithOptions: { values: { respondWith: 'text', formSubmittedText: evil } } },
    });
    expect(html).not.toContain(evil);
    expect(html).toContain('\\u003c/script>');
  });

  it('prefills defaults and hidden fields from the query, literally', async () => {
    const html = await page(
      {
        formTitle: 'T',
        ...fields(
          { fieldLabel: 'Name', fieldType: 'text', defaultValue: 'x' },
          { fieldType: 'hiddenField', fieldName: 'source', fieldValue: 'site' },
          {
            fieldLabel: 'Pick',
            fieldType: 'dropdown',
            fieldOptions: { values: [{ option: 'A' }, { option: 'B' }] },
          },
          {
            fieldLabel: 'Tags',
            fieldType: 'checkbox',
            fieldOptions: { values: [{ option: 'A' }, { option: 'B' }] },
          },
          { fieldLabel: 'Pass', fieldType: 'password' },
        ),
      },
      {
        query: { Name: '{{ 1+1 }} $& "q"', source: '=$json', Pick: 'B', Tags: 'A,B', Pass: 'leak' },
      },
    );
    expect(html).toContain('value="{{ 1+1 }} $&amp; &quot;q&quot;"');
    expect(html).toContain('value="=$json"');
    expect(html).toContain('<option value="B" selected');
    expect(html.match(/type="checkbox"[^>]* checked/g)).toHaveLength(2);
    expect(html).not.toContain('leak');
  });

  it('uses the default value when the query has none', async () => {
    const html = await page({
      formTitle: 'T',
      ...fields(
        { fieldLabel: 'Name', fieldType: 'text', defaultValue: 'Ann' },
        {
          fieldLabel: 'Size',
          fieldType: 'radio',
          defaultValue: 'L',
          fieldOptions: { values: [{ option: 'S' }, { option: 'L' }] },
        },
      ),
    });
    expect(html).toContain('value="Ann"');
    expect(html).toMatch(/value="L"[^>]* checked/);
  });

  it('shows a test notice only in test mode, and the attribution unless turned off', async () => {
    const notice = 'This is a test version of your form';
    expect(await page({ formTitle: 'T' }, { mode: 'manual' })).toContain(notice);
    expect(await page({ formTitle: 'T' })).not.toContain(notice);
    expect(await page({ formTitle: 'T' })).toContain('Form automated with Workflow');
    expect(await page({ formTitle: 'T', options: { appendAttribution: false } })).not.toContain(
      'Form automated with',
    );
  });

  it('keeps the custom CSS from closing its style element', async () => {
    const html = await page({
      formTitle: 'T',
      options: { customCss: 'h1 { color: red } </style><script>alert(1)</script>' },
    });
    expect(html).toContain('h1 { color: red }');
    expect(html).not.toContain('</style><script>alert(1)');
  });
});

describe('HTML fields and the description', () => {
  const htmlField = (html: string) => fields({ fieldType: 'html', html });

  it('resolves each {{ }} of an HTML field once from the parameter text', async () => {
    const html = await page({ formTitle: 'T', ...htmlField('<p>{{ 1+1 }} and {{ 2+2 }}</p>') });
    expect(html).toContain('<p>2 and 4</p>');
  });

  it('does not resolve what a {{ }} gave', async () => {
    const html = await page({ formTitle: 'T', ...htmlField('<p>{{ "{{ 1+1 }}" }}</p>') });
    expect(html).toContain('<p>{{ 1+1 }}</p>');
  });

  it('does not resolve a =-prefixed value a second time', async () => {
    const html = await page({ formTitle: 'T', ...htmlField('=<p>{{ "{{ 1+1 }}" }}</p>') });
    expect(html).toContain('<p>{{ 1+1 }}</p>');
  });

  it('keeps $& and friends unchanged in resolved text and around it', async () => {
    const html = await page({ formTitle: 'T', ...htmlField("<p>$& $1 $` $' {{ '$&' }}</p>") });
    expect(html).toContain("<p>$&amp; $1 $` $' $&amp;</p>");
  });

  it('leaves a broken {{ }} as it was', async () => {
    const html = await page({ formTitle: 'T', ...htmlField('<p>{{ 1 + }}</p>') });
    expect(html).toContain('<p>{{ 1 + }}</p>');
  });

  it('renders the description sanitized, with a literal {{ }} and $&', async () => {
    const html = await page({
      formTitle: 'T',
      formDescription: '<b onclick="x()">{{ 1+1 }} $&</b><script>alert(1)</script>',
    });
    expect(html).toContain('<b>{{ 1+1 }} $&amp;</b>');
    expect(html).not.toContain('alert(1)');
  });

  it('sanitizes an HTML field after resolving it', async () => {
    const html = await page({
      formTitle: 'T',
      ...htmlField(`<p>{{ '<img src=x onerror=alert(1)>' }}</p>`),
    });
    expect(html).not.toContain('onerror');
  });
});

describe('sanitizers', () => {
  it('removes scripts, handlers, styles and inputs', () => {
    const out = sanitizeHtml(
      '<p onclick="a()">ok</p><script>b()</script><style>c{}</style><input name="x"><form action="/x"></form>',
    );
    expect(out).toBe('<p>ok</p>');
  });

  it('allows only http and https links and sources', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a rel="noopener noreferrer">x</a>');
    expect(sanitizeHtml('<img src="data:image/png;base64,AA">')).toBe('<img />');
    expect(sanitizeHtml('<a href="//evil.example">x</a>')).toBe('<a rel="noopener noreferrer">x</a>');
    expect(sanitizeHtml('<a href="https://ok.example/a">x</a>')).toContain('href="https://ok.example/a"');
  });

  it('forces an empty sandbox on iframes', () => {
    const out = sanitizeHtml(
      '<iframe src="https://ok.example" sandbox="allow-scripts allow-same-origin" srcdoc="<script>"></iframe>',
    );
    expect(out).toMatch(/<iframe [^>]*\bsandbox(="")?[ >]/);
    expect(out).not.toContain('allow-');
    expect(out).not.toContain('srcdoc');
  });

  it('drops ids, so a field cannot stand in for the page elements', () => {
    expect(sanitizeHtml('<p id="form" name="x" class="a">ok</p>')).toBe('<p class="a">ok</p>');
  });

  it('removes `<` from CSS, entities cannot bring it back', () => {
    expect(sanitizeCustomCss('a{}</style><b>')).not.toContain('<');
    expect(sanitizeCustomCss('a{content:"&lt;"}')).toBe('a{content:"&lt;"}');
  });

  it('accepts only http and https redirects', () => {
    expect(safeRedirectUrl('https://ok.example/a?b=1')).toBe('https://ok.example/a?b=1');
    expect(safeRedirectUrl('ok.example/a')).toBe('http://ok.example/a');
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://ok.example',
      '',
      'JaVaScRiPt:alert(1)',
    ]) {
      expect(safeRedirectUrl(bad), bad).toBeUndefined();
    }
  });

  it('writes a message page with every value escaped', () => {
    const html = renderMessagePage({ title: '<t>', message: '<m>' });
    expect(html).toContain('&lt;t&gt;');
    expect(html).toContain('&lt;m&gt;');
    expect(html).not.toContain('<m>');
  });
});

describe('submission output', () => {
  const definition = {
    formTitle: 'T',
    ...fields(
      { fieldLabel: 'Name', fieldType: 'text' },
      { fieldLabel: 'Note', fieldName: 'note_key', fieldType: 'textarea' },
      { fieldLabel: 'Age', fieldType: 'number' },
      { fieldLabel: 'Mail', fieldType: 'email' },
      {
        fieldLabel: 'Tags',
        fieldType: 'checkbox',
        fieldOptions: { values: [{ option: 'A' }, { option: 'B' }] },
      },
      {
        fieldLabel: 'Size',
        fieldType: 'radio',
        fieldOptions: { values: [{ option: 'S' }, { option: 'L' }] },
      },
      { fieldLabel: 'Missing', fieldType: 'text' },
      { fieldType: 'hiddenField', fieldName: 'source' },
      { fieldType: 'html', html: '<p>x</p>', elementName: 'terms' },
      { fieldType: 'html', html: '<p>y</p>' },
    ),
  };

  it('has one key per field, then submittedAt and formMode', async () => {
    const { json } = await submit(definition, {
      body: {
        'field-0': '  Ann ',
        'field-1': ' keeps spaces ',
        'field-2': '42',
        'field-3': ' a@b.c ',
        'field-4': ['A', 'B'],
        'field-5': 'L',
        'field-7': 'site',
      },
    });
    expect(json).toMatchObject({
      Name: 'Ann',
      note_key: ' keeps spaces ',
      Age: 42,
      Mail: 'a@b.c',
      Tags: ['A', 'B'],
      Size: 'L',
      Missing: null,
      source: 'site',
      terms: '<p>x</p>',
      formMode: 'production',
    });
    expect(Object.keys(json)).toEqual([
      'Name',
      'note_key',
      'Age',
      'Mail',
      'Tags',
      'Size',
      'Missing',
      'source',
      'terms',
      'submittedAt',
      'formMode',
    ]);
    expect(Number.isNaN(Date.parse(String(json.submittedAt)))).toBe(false);
  });

  it('parses checkbox and radio values sent as JSON, radio takes the first', async () => {
    const { json } = await submit(definition, { body: { 'field-4': '["A"]', 'field-5': '["S","L"]' } });
    expect(json.Tags).toEqual(['A']);
    expect(json.Size).toBe('S');
  });

  it('an empty number is null, and a single checkbox value is a list', async () => {
    const { json } = await submit(definition, { body: { 'field-2': '', 'field-4': 'A' } });
    expect(json.Age).toBeNull();
    expect(json.Tags).toEqual(['A']);
  });

  it('keeps a submitted {{ 1+1 }} and $& literal', async () => {
    const { json } = await submit(definition, { body: { 'field-0': '{{ 1+1 }}', 'field-1': '=$& $1' } });
    expect(json.Name).toBe('{{ 1+1 }}');
    expect(json.note_key).toBe('=$& $1');
  });

  it('marks a test submission and outputs the query', async () => {
    const { json } = await submit(definition, { mode: 'manual', query: { ref: 'mail' } });
    expect(json.formMode).toBe('test');
    expect(json.formQueryParameters).toEqual({ ref: 'mail' });
  });

  it('leaves formQueryParameters out when the query is empty', async () => {
    const { json } = await submit(definition);
    expect(json).not.toHaveProperty('formQueryParameters');
    expect(json).not.toHaveProperty('headers');
  });

  it('does not let a field name reach the prototype', async () => {
    const { json } = await submit(
      { formTitle: 'T', ...fields({ fieldLabel: 'x', fieldName: '__proto__', fieldType: 'text' }) },
      { body: { 'field-0': 'polluted' } },
    );
    expect(Object.getPrototypeOf(json)).toBe(Object.prototype);
    expect(JSON.stringify(json)).not.toContain('polluted');
  });

  it('stores a file as binary with metadata in the field', async () => {
    const { json, item } = await submit(
      { formTitle: 'T', ...fields({ fieldLabel: 'My doc!', fieldType: 'file' }) },
      {
        files: [
          {
            fieldName: 'field-0',
            fileName: 'a.txt',
            mimeType: 'text/plain',
            data: new TextEncoder().encode('hello'),
          },
        ],
      },
    );
    expect(json['My doc!']).toEqual([{ filename: 'a.txt', mimetype: 'text/plain', size: 5 }]);
    expect(item?.binary?.My_doc_).toMatchObject({ fileName: 'a.txt', mimeType: 'text/plain' });
  });

  it('numbers several files, and ignores an empty file input', async () => {
    const data = new TextEncoder().encode('x');
    const { json, item } = await submit(
      {
        formTitle: 'T',
        ...fields({ fieldLabel: 'Docs', fieldType: 'file' }, { fieldLabel: 'None', fieldType: 'file' }),
      },
      {
        files: [
          { fieldName: 'field-0', fileName: 'a.txt', mimeType: 'text/plain', data },
          { fieldName: 'field-0', fileName: 'b.txt', mimeType: 'text/plain', data },
          {
            fieldName: 'field-1',
            fileName: '',
            mimeType: 'application/octet-stream',
            data: new Uint8Array(),
          },
        ],
      },
    );
    expect(Object.keys(item?.binary ?? {})).toEqual(['Docs_0', 'Docs_1']);
    expect(json.Docs).toHaveLength(2);
    expect(json.None).toBeNull();
  });

  it('Show Headers leaves out authorization, cookie and x-auth-token', async () => {
    const { json } = await submit(
      { formTitle: 'T', options: { showHeaders: true } },
      {
        headers: { 'user-agent': 'ua', authorization: 'Basic x', cookie: 'a=b', 'x-auth-token': 'tok' },
      },
    );
    expect(json.headers).toEqual({ 'user-agent': 'ua' });
  });

  it('submittedAt follows the workflow timezone unless turned off', async () => {
    const zoned = await submit({ formTitle: 'T' }, { timezone: 'Asia/Kolkata' });
    expect(String(zoned.json.submittedAt)).toMatch(/\+05:30$/);
    const utc = await submit(
      { formTitle: 'T', options: { useWorkflowTimezone: false } },
      { timezone: 'Asia/Kolkata' },
    );
    expect(String(utc.json.submittedAt)).toMatch(/Z$/);
  });
});

describe('completion', () => {
  const text = (result: WebhookResponseData) => result.webhookResponse?.body as DataObject;

  it('answers the default text', async () => {
    const { result } = await submit({ formTitle: 'T' });
    expect(result.webhookResponse?.statusCode).toBe(200);
    expect(text(result)).toEqual({ formSubmittedText: 'Your response has been recorded' });
  });

  it('answers the configured text', async () => {
    const { result } = await submit({
      formTitle: 'T',
      options: { respondWithOptions: { values: { respondWith: 'text', formSubmittedText: 'Thanks' } } },
    });
    expect(text(result)).toEqual({ formSubmittedText: 'Thanks' });
  });

  it('answers a redirect only for an http(s) URL', async () => {
    const redirect = (redirectUrl: string) => ({
      formTitle: 'T',
      options: { respondWithOptions: { values: { respondWith: 'redirect', redirectUrl } } },
    });
    expect(text((await submit(redirect('https://ok.example/x'))).result)).toEqual({
      redirectURL: 'https://ok.example/x',
    });
    expect(text((await submit(redirect('javascript:alert(1)'))).result)).toEqual({
      formSubmittedText: 'Your response has been recorded',
    });
  });

  it('the page knows the ending too, for a run that answers when it finishes', async () => {
    const html = await page({
      formTitle: 'T',
      responseMode: 'lastNode',
      options: {
        respondWithOptions: { values: { respondWith: 'redirect', redirectUrl: 'https://ok.example/x' } },
      },
    });
    expect(html).toContain('"redirectUrl":"https://ok.example/x"');
    const bad = await page({
      formTitle: 'T',
      options: {
        respondWithOptions: { values: { respondWith: 'redirect', redirectUrl: 'javascript:alert(1)' } },
      },
    });
    expect(bad).not.toContain('javascript:alert');
  });
});

describe('Respond to Webhook', () => {
  const refused = {
    nodes: [node('Respond', 'core.respondToWebhook', {})],
    connections: connect(['Form', 'Respond']),
  };
  const TEXT = 'The "Respond to Webhook" node is not supported in workflows initiated by the "Form Trigger"';

  it('refuses the page with the reason and how to fix it', async () => {
    const result = await call({ formTitle: 'T' }, refused);
    expect(result.workflowData).toBeUndefined();
    expect(result.webhookResponse?.statusCode).toBe(409);
    const html = String(result.webhookResponse?.body);
    expect(html).toContain(TEXT.replaceAll('"', '&quot;'));
    expect(html).toContain('Form Ending');
  });

  it('refuses a submission without starting a run', async () => {
    const result = await call({ formTitle: 'T' }, { ...refused, method: 'POST' });
    expect(result.workflowData).toBeUndefined();
    expect(result.webhookResponse?.statusCode).toBe(409);
    expect(result.webhookResponse?.body).toMatchObject({ message: TEXT });
  });

  it('lets a workflow without that node through', async () => {
    const other = { nodes: [node('Set', 'core.noOp', {})], connections: connect(['Form', 'Set']) };
    expect((await call({ formTitle: 'T' }, other)).webhookResponse?.statusCode).toBe(200);
  });
});

describe('IP allowlist', () => {
  it('matches exact addresses and CIDR ranges', () => {
    expect(ipAllowed('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipAllowed('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(ipAllowed('1.2.3.4', '9.9.9.9, 1.2.3.4')).toBe(true);
    expect(ipAllowed('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(ipAllowed('2001:db9::1', '2001:db8::/32')).toBe(false);
  });

  it('treats an IPv4-mapped address as IPv4', () => {
    expect(ipAllowed('::ffff:10.1.2.3', '10.0.0.0/8')).toBe(true);
  });

  it('an empty list allows anyone, a list refuses an unknown address', () => {
    expect(ipAllowed(undefined, '')).toBe(true);
    expect(ipAllowed(undefined, '1.2.3.4')).toBe(false);
  });

  it('ignores an entry it cannot read', () => {
    expect(ipAllowed('1.2.3.4', 'nonsense, 1.2.3.4, 10.0.0.0/99')).toBe(true);
    expect(ipAllowed('1.2.3.5', 'nonsense')).toBe(false);
  });

  it("refuses the page and the submission with n8n's text", async () => {
    const parameters = { formTitle: 'T', options: { ipWhitelist: '10.0.0.0/8' } };
    for (const method of ['GET', 'POST'] as const) {
      const result = await call(parameters, { method, ip: '11.0.0.1' });
      expect(result.workflowData).toBeUndefined();
      expect(result.webhookResponse?.statusCode).toBe(403);
      expect(String(result.webhookResponse?.body)).toContain('IP is not allowed to access this form!');
    }
    expect((await call(parameters, { ip: '10.0.0.1' })).webhookResponse?.statusCode).toBe(200);
  });
});

describe('Ignore Bots', () => {
  const parameters = { formTitle: 'T', options: { ignoreBots: true } };
  const asBot = { headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0' } };

  it('answers a bot 401 with no body', async () => {
    const result = await call(parameters, asBot);
    expect(result.webhookResponse?.statusCode).toBe(401);
    expect(result.webhookResponse?.headers?.['www-authenticate']).toBe('Basic realm="Enter credentials"');
    expect(result.webhookResponse?.body).toBeUndefined();
  });

  it('lets people through, and bots when the option is off', async () => {
    const browser = { headers: { 'user-agent': 'Mozilla/5.0' } };
    expect((await call(parameters, browser)).webhookResponse?.statusCode).toBe(200);
    expect((await call({ formTitle: 'T' }, asBot)).webhookResponse?.statusCode).toBe(200);
  });
});

describe('Basic auth', () => {
  const parameters = { formTitle: 'T', authentication: 'basicAuth' };
  const formTokens = fakeTokens();
  const options = { creds: BASIC_CREDS, services: { formTokens } };
  const tokenOf = (html: string) => /"authToken":"([^"]+)"/.exec(html)?.[1];
  const signedPage = () =>
    page(parameters, { ...options, headers: { authorization: basicHeader('ann', 'secret') } });

  it('asks a visitor for credentials', async () => {
    const result = await call(parameters, options);
    expect(result.webhookResponse?.statusCode).toBe(401);
    expect(result.webhookResponse?.headers?.['www-authenticate']).toBe('Basic realm="Enter credentials"');
    expect(String(result.webhookResponse?.body)).not.toContain('secret');
  });

  it('refuses wrong credentials', async () => {
    const result = await call(parameters, {
      ...options,
      headers: { authorization: basicHeader('ann', 'wrong') },
    });
    expect(result.webhookResponse?.statusCode).toBe(401);
  });

  it('a form with no auth holds no token', async () => {
    expect(await page({ formTitle: 'T' })).toContain('"authToken":null');
  });

  it("the page holds a token, and the page's POST sends it", async () => {
    const token = tokenOf(await signedPage());
    expect(token).toBeTruthy();
    const { result, json } = await submit(parameters, { ...options, headers: { 'x-auth-token': token! } });
    expect(result.workflowData).toBeDefined();
    expect(json).not.toHaveProperty('x-auth-token');
  });

  it('a POST with Basic credentials and no token passes', async () => {
    const { result } = await submit(parameters, {
      ...options,
      headers: { authorization: basicHeader('ann', 'secret') },
    });
    expect(result.workflowData).toBeDefined();
  });

  it('refuses a forged token and a POST with nothing', async () => {
    for (const headers of [{ 'x-auth-token': 'forged' }, {}]) {
      const { result } = await submit(parameters, { ...options, headers });
      expect(result.workflowData).toBeUndefined();
      expect(result.webhookResponse?.statusCode).toBe(401);
    }
  });

  it('a token dies with the password it was issued under', async () => {
    const token = tokenOf(await signedPage());
    const { result } = await submit(parameters, {
      services: { formTokens },
      creds: { httpBasicAuth: { user: 'ann', password: 'rotated' } },
      headers: { 'x-auth-token': token! },
    });
    expect(result.webhookResponse?.statusCode).toBe(401);
  });

  it('a token of another form is refused', async () => {
    const token = formTokens.sign(
      { kind: 'form-basic', tenantId: 't1', workflowId: 'other', node: 'Form', credential: 'x' },
      60,
    );
    const { result } = await submit(parameters, { ...options, headers: { 'x-auth-token': token } });
    expect(result.webhookResponse?.statusCode).toBe(401);
  });

  it('never prints the password', async () => {
    const html = await signedPage();
    expect(html).not.toContain('secret');
    expect(html).not.toContain(basicHeader('ann', 'secret'));
  });
});

describe('user auth', () => {
  const parameters = { formTitle: 'T', authentication: 'n8nUserAuth', requireExecuteAccess: true };
  const user = { id: 'u1', email: 'a@b.c', firstName: 'Ann', lastName: 'Lee' };
  const cookie = 'ncb-form-auth-wf-wf-1=the-token; Path=/form; HttpOnly; Secure; SameSite=Lax';

  it('sends what the check answers when it refuses, with its headers', async () => {
    userAuth.mockResolvedValue({
      allowed: false,
      headers: { 'x-from-check': '1' },
      response: { statusCode: 302, headers: { location: '/signin' } },
    });
    const result = await call(parameters);
    expect(result.workflowData).toBeUndefined();
    expect(result.webhookResponse).toMatchObject({
      statusCode: 302,
      headers: { location: '/signin', 'x-from-check': '1' },
    });
    expect(userAuth).toHaveBeenCalledWith(expect.anything(), {
      scope: 'trigger',
      requireExecuteAccess: true,
    });
  });

  it("passes the cookie on the page, and hands the token to the page's POST", async () => {
    userAuth.mockResolvedValue({ allowed: true, user, headers: { 'set-cookie': cookie } });
    const result = await call(parameters);
    expect(result.webhookResponse?.headers?.['set-cookie']).toBe(cookie);
    expect(String(result.webhookResponse?.body)).toContain('"authToken":"the-token"');
  });

  it('adds the user to the output by default', async () => {
    userAuth.mockResolvedValue({ allowed: true, user, headers: {} });
    const { json } = await submit(parameters);
    expect(json.user).toEqual(user);
  });

  it('Include User in Output off drops it', async () => {
    userAuth.mockResolvedValue({ allowed: true, user, headers: {} });
    const { json } = await submit({ ...parameters, options: { includeUserInOutput: false } });
    expect(json).not.toHaveProperty('user');
  });

  it('never copies `code` to a prefill or the output', async () => {
    userAuth.mockResolvedValue({ allowed: true, user, headers: {} });
    const definition = { ...parameters, ...fields({ fieldLabel: 'code', fieldType: 'text' }) };
    const query = { code: 'one-time', ref: 'mail' };
    expect(await page(definition, { query })).not.toContain('one-time');
    const { json } = await submit(definition, { query });
    expect(json.formQueryParameters).toEqual({ ref: 'mail' });
  });

  it('is not called for other forms', async () => {
    await call({ formTitle: 'T' });
    expect(userAuth).not.toHaveBeenCalled();
  });
});
