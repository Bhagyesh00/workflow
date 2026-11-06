/** P4-02: the Form node and the Wait node's form resume through real contexts and the engine. */
import { createWebhookContext, type ExecutionServices } from '@workflow/core';
import {
  type Connections,
  type DataObject,
  type ExecutionState,
  ExpressionEvaluator,
  type Item,
  type WebhookResponse,
  type WebhookResponseData,
  Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderCompletionPage, renderFormPage } from '../src/nodes/core/form/render';
import { checkFormUserAuth } from '../src/nodes/core/form/user-auth';
import { limitWaitProperties } from '../src/nodes/core/wait-limit';
import { connect, node, nodeTypes, runWorkflow, testServices } from './harness';

vi.mock('../src/nodes/core/form/user-auth', () => ({
  userAuthProperties: [],
  checkFormUserAuth: vi.fn(),
}));

const fakeTokens = () => {
  const issued = new Map<string, DataObject>();
  return {
    sign(payload: DataObject) {
      const token = `tok-${issued.size + 1}`;
      issued.set(token, payload);
      return token;
    },
    verify: (token: string) => issued.get(token) ?? null,
  };
};

const FORM_URL = 'http://localhost:5678/form-waiting/e1/sig';

interface CallOptions {
  method?: 'GET' | 'POST';
  body?: DataObject;
  query?: DataObject;
  headers?: Record<string, string>;
  input?: Item[];
  trigger?: DataObject;
  triggerExtra?: Partial<WorkflowNode>;
  /** the page node's type; Form by default */
  type?: string;
  /** more nodes after the page node, chained */
  children?: WorkflowNode[];
  connections?: Connections;
  mode?: 'manual' | 'webhook';
  creds?: Record<string, DataObject>;
  services?: Partial<ExecutionServices>;
  noTrigger?: boolean;
}

/** the page node's webhook(), with the state of a run waiting at it */
async function call(parameters: DataObject, options: CallOptions = {}): Promise<WebhookResponseData> {
  const method = options.method ?? 'GET';
  const input = options.input ?? [{ json: { Name: 'Ann' } }];
  const nodes = [
    ...(options.noTrigger
      ? [node('Start', 'core.manualTrigger')]
      : [
          node(
            'Start',
            'core.formTrigger',
            { formTitle: 'From the trigger', ...options.trigger },
            [0, 0],
            options.triggerExtra,
          ),
        ]),
    node('Page', options.type ?? 'core.form', parameters, [200, 0], {
      credentials: options.creds?.httpBasicAuth ? { httpBasicAuth: { id: 'c', name: 'Login' } } : undefined,
    }),
    ...(options.children ?? []),
  ];
  const names = nodes.map((n) => n.name);
  const connections =
    options.connections ?? connect(...names.slice(1).map((name, i) => [names[i], name] as [string, string]));
  const workflow = new Workflow({ id: 'wf-1', name: 'forms', nodes, connections }, nodeTypes);
  const task = (main: Item[]) => ({
    startTime: 1,
    executionTime: 1,
    executionStatus: 'success' as const,
    data: { main: [main] },
    source: [],
  });
  const state = {
    resultData: { runData: { Start: [task(input)], Page: [{ ...task(input), executionStatus: 'waiting' }] } },
    executionData: {},
  } as unknown as ExecutionState;
  const ctx = createWebhookContext(
    {
      workflow,
      node: workflow.nodes.Page,
      services: testServices(options.creds ?? {}, {
        mode: options.mode ?? 'webhook',
        formTokens: fakeTokens(),
        resumeFormUrl: FORM_URL,
        ...options.services,
      }),
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
      state,
      runIndex: 0,
      executeData: { node: 'Page', data: { main: [input] }, source: { main: [null] } },
    },
    {
      method,
      headers: options.headers ?? {},
      query: options.query ?? {},
      params: {},
      body: options.body ?? {},
    },
    'default',
  );
  return nodeTypes.get(options.type ?? 'core.form')!.webhook!(ctx);
}

const pageOf = async (parameters: DataObject, options: CallOptions = {}) => {
  const result = await call(parameters, options);
  expect(result.workflowData).toBeUndefined();
  return String(result.webhookResponse?.body);
};

const textField = { formFields: { values: [{ fieldLabel: 'City', fieldType: 'text' }] } };

afterEach(() => vi.mocked(checkFormUserAuth).mockReset());

describe('Form node: execute', () => {
  const trigger = node('Start', 'core.formTrigger', { formTitle: 'T' });

  it('refuses to run without a Form Trigger before it', async () => {
    const run = await runWorkflow(
      [node('Start', 'core.manualTrigger'), node('Page', 'core.form', { operation: 'page' }, [200, 0])],
      connect(['Start', 'Page']),
    );
    expect(run.status).toBe('error');
    expect(run.error?.message).toBe('Form Trigger node must be set before this node');
  });

  it('refuses an ending that has a form page after it', async () => {
    const run = await runWorkflow(
      [
        trigger,
        node('Page', 'core.form', { operation: 'completion' }, [200, 0]),
        node('Next', 'core.form', { operation: 'page' }, [400, 0]),
      ],
      connect(['Start', 'Page'], ['Page', 'Next']),
    );
    expect(run.status).toBe('error');
    expect(run.error?.message).toBe('Completion has to be the last Form node in the workflow');
  });

  it('puts the run to wait, sets the metadata and sends the next page URL as a 307', async () => {
    const responses: WebhookResponse[] = [];
    const run = await runWorkflow(
      [trigger, node('Page', 'core.form', { operation: 'page' }, [200, 0])],
      connect(['Start', 'Page']),
      [{ json: { a: 1 } }],
      {
        services: {
          resumeFormUrl: FORM_URL,
          hooks: { sendResponse: (response) => responses.push(response) },
        },
      },
    );
    expect(run.status).toBe('waiting');
    const task = run.runData.Page[0];
    expect(task.executionStatus).toBe('waiting');
    expect(task.metadata?.resumeFormUrl).toBe(FORM_URL);
    expect(responses).toEqual([{ statusCode: 307, headers: { location: FORM_URL } }]);
    expect(new Date(run.result.state.waitTill as string).getFullYear()).toBe(3000);
  });

  it('Limit Wait Time sets when the wait ends', async () => {
    const run = await runWorkflow(
      [
        trigger,
        node('Page', 'core.form', { limitWaitTime: true, resumeAmount: 2, resumeUnit: 'hours' }, [200, 0]),
      ],
      connect(['Start', 'Page']),
    );
    const left = new Date(run.result.state.waitTill as string).getTime() - Date.now();
    expect(left).toBeGreaterThan(3_600_000);
    expect(left).toBeLessThanOrEqual(7_200_000);
  });

  it('shares the limit properties with Wait', () => {
    const names = limitWaitProperties().map((p) => p.name);
    expect(names).toEqual(['limitWaitTime', 'limitType', 'resumeAmount', 'resumeUnit', 'maxDateAndTime']);
    const waitProperties = nodeTypes.get('core.wait')!.description.properties.map((p) => p.name);
    const formProperties = nodeTypes.get('core.form')!.description.properties.map((p) => p.name);
    for (const name of names) {
      expect(waitProperties).toContain(name);
      expect(formProperties).toContain(name);
    }
  });
});

describe('Form node: page', () => {
  it('shows the fields with the title and button of the trigger when it names none', async () => {
    const body = await pageOf(textField, {
      trigger: { options: { buttonLabel: 'Go on', appendAttribution: false } },
    });
    expect(body).toContain('From the trigger');
    expect(body).toContain('Go on');
    expect(body).toContain('City');
    expect(body).not.toContain('Form automated with Workflow');
  });

  it('its own options win, and the page is marked as a test in a test run', async () => {
    const body = await pageOf(
      { ...textField, options: { formTitle: 'Step two', buttonLabel: 'Done', formDescription: '<b>Hi</b>' } },
      { mode: 'manual' },
    );
    expect(body).toContain('Step two');
    expect(body).toContain('Done');
    expect(body).toContain('<b>Hi</b>');
    expect(body).toContain('This is a test version of your form');
    expect(body).not.toContain('From the trigger');
  });

  it('a node name with a quote still reads the trigger', async () => {
    const workflowNodes = [
      node('It\'s "the" form', 'core.formTrigger', { formTitle: 'Quoted' }),
      node('Page', 'core.form', textField, [200, 0]),
    ];
    const workflow = new Workflow(
      {
        id: 'wf',
        name: 'q',
        nodes: workflowNodes,
        connections: connect(['It\'s "the" form', 'Page']),
      },
      nodeTypes,
    );
    const ctx = createWebhookContext(
      {
        workflow,
        node: workflow.nodes.Page,
        services: testServices({}, { formTokens: fakeTokens() }),
        evaluator: new ExpressionEvaluator(),
        signal: new AbortController().signal,
      },
      { method: 'GET', headers: {}, query: {}, params: {}, body: {} },
      'default',
    );
    const result = await nodeTypes.get('core.form')!.webhook!(ctx);
    expect(String(result.webhookResponse?.body)).toContain('Quoted');
  });

  it('takes a prefill from the query, but never the sign-in code', async () => {
    const field = { formFields: { values: [{ fieldLabel: 'code', fieldType: 'text' }] } };
    const plain = await pageOf(field, { query: { code: 'prefilled' } });
    expect(plain).toContain('value="prefilled"');

    vi.mocked(checkFormUserAuth).mockResolvedValue({ allowed: true, headers: {} });
    const signedIn = await pageOf(field, {
      query: { code: 'one-time' },
      trigger: { authentication: 'n8nUserAuth' },
    });
    expect(signedIn).not.toContain('one-time');
  });

  it('a POST gives the answers, submittedAt and formMode', async () => {
    const result = await call(textField, { method: 'POST', body: { 'field-0': ' Pune ' }, mode: 'manual' });
    const item = result.workflowData?.[0]?.[0];
    expect(item?.json.City).toBe('Pune');
    expect(item?.json.formMode).toBe('test');
    expect(typeof item?.json.submittedAt).toBe('string');
    expect(result.webhookResponse).toBeDefined();
  });

  it('uses the workflow timezone unless the trigger turns it off', async () => {
    const off = await call(textField, {
      method: 'POST',
      trigger: { options: { useWorkflowTimezone: false } },
    });
    expect(String(off.workflowData?.[0]?.[0]?.json.submittedAt)).toMatch(/Z$/);
  });

  describe('expressions in an HTML field', () => {
    const html = (text: string) => ({
      formFields: { values: [{ fieldType: 'html', html: text }] },
    });

    it('a = field reads the input once: a submitted {{ 1+1 }} stays literal', async () => {
      const body = await pageOf(html('=<h2>{{ $input.first().json.Name }}</h2>'), {
        input: [{ json: { Name: '{{ 1+1 }}' } }],
      });
      expect(body).toContain('<h2>{{ 1+1 }}</h2>');
      expect(body).not.toContain('<h2>2</h2>');
    });

    it('$& and $1 in a value stay as they are', async () => {
      const body = await pageOf(html('=<h2>{{ $input.first().json.Name }}</h2>'), {
        input: [{ json: { Name: "$& $1 $' $`" } }],
      });
      expect(body).toContain("<h2>$&amp; $1 $' $`</h2>");
    });

    it('a plain field has each {{ }} of its own text resolved once', async () => {
      const body = await pageOf(html('<h2>{{ 1+1 }} {{ $input.first().json.Name }}</h2>'), {
        input: [{ json: { Name: '{{ 3+3 }}' } }],
      });
      expect(body).toContain('<h2>2 {{ 3+3 }}</h2>');
    });

    it('a script from the input is removed', async () => {
      const body = await pageOf(html('={{ $input.first().json.Name }}'), {
        input: [{ json: { Name: '<img src=x onerror=alert(1)><script>alert(2)</script>' } }],
      });
      expect(body).not.toContain('onerror');
      expect(body).not.toContain('alert(2)');
    });
  });

  describe('JSON form definition', () => {
    const json = (jsonOutput: unknown) => ({ defineForm: 'json', jsonOutput });

    it('shows the fields of a JSON text and takes the answers by them', async () => {
      const definition = JSON.stringify([
        { fieldLabel: 'Colour', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'Red' }] } },
        { fieldLabel: 'Age', fieldType: 'number', requiredField: true },
      ]);
      const body = await pageOf(json(definition));
      expect(body).toContain('Colour');
      expect(body).toContain('Red');
      const result = await call(json(definition), {
        method: 'POST',
        body: { 'field-0': 'Red', 'field-1': '30' },
      });
      expect(result.workflowData?.[0]?.[0]?.json).toMatchObject({ Colour: 'Red', Age: 30 });
    });

    it('takes an expression that gives the definition, and never reads a value in it again', async () => {
      const body = await pageOf(json('={{ $input.first().json.fields }}'), {
        input: [{ json: { fields: [{ fieldType: 'html', html: '<p>{{ 1+1 }}</p>' }] } }],
      });
      expect(body).toContain('<p>{{ 1+1 }}</p>');
    });

    it.each([
      ['not JSON', 'nope'],
      ['not a list', '{"fieldLabel":"A"}'],
      ['an entry that is no object', '[1]'],
      ['an unknown type', '[{"fieldLabel":"A","fieldType":"script"}]'],
    ])('refuses %s', async (_name, definition) => {
      await expect(call(json(definition))).rejects.toThrow('The form fields JSON is not valid');
    });
  });
});

describe('Form node: ending', () => {
  const ending = (parameters: DataObject) => ({ operation: 'completion', ...parameters });

  it('a POST finishes with the input items and a GET shows the page', async () => {
    const parameters = ending({ respondWith: 'text', completionTitle: 'Thanks', completionMessage: 'Bye' });
    const body = await pageOf(parameters);
    expect(body).toContain('Thanks');
    expect(body).toContain('Bye');
    expect(body).toContain('method: &#39;POST&#39;'.replace(/&#39;/g, "'"));
    const posted = await call(parameters, { method: 'POST' });
    expect(posted.workflowData?.[0]?.map((i) => i.json)).toEqual([{ Name: 'Ann' }]);
  });

  it('its options name the tab, the attribution and the styling', async () => {
    const options = { formTitle: 'The tab', appendAttribution: false, customCss: 'p{color:red}</style>' };
    const body = await pageOf(ending({ completionTitle: 'Thanks', options }));
    expect(body).toContain('<title>The tab</title>');
    expect(body).not.toContain('Form automated with Workflow');
    expect(body).toContain('p{color:red}');
    expect(body).not.toContain('</style>x');
    const plain = await pageOf(ending({ completionTitle: 'Thanks' }));
    expect(plain).toContain('<title>From the trigger</title>');
    expect(plain).toContain('Form automated with Workflow');
  });

  it('escapes the title and message', async () => {
    const body = await pageOf(ending({ completionTitle: '<i>T</i>', completionMessage: '<i>M</i>' }));
    expect(body).not.toContain('<i>');
    expect(body).toContain('&lt;i&gt;M&lt;/i&gt;');
  });

  it('a redirect ending names an http or https URL only', async () => {
    const good = await pageOf(ending({ respondWith: 'redirect', redirectUrl: 'https://example.com/done' }));
    expect(good).toContain('https://example.com/done');
    const bad = await pageOf(ending({ respondWith: 'redirect', redirectUrl: 'javascript:alert(1)' }));
    expect(bad).not.toContain('javascript:alert');
    expect(bad).toContain('Your response has been recorded');
  });

  it('Show Text resolves its own {{ }} once and sanitizes', async () => {
    const body = await pageOf(
      ending({
        respondWith: 'showText',
        responseText: '<b>{{ $input.first().json.Name }}</b><script>x()</script>',
      }),
      { input: [{ json: { Name: '{{ 1+1 }}' } }] },
    );
    expect(body).toContain('<b>{{ 1+1 }}</b>');
    expect(body).not.toContain('x()');
  });

  it('Return Binary File embeds the files of its input', async () => {
    const data = Buffer.from('hello').toString('base64');
    const binary = { data, mimeType: 'text/plain', fileName: 'a</script>.txt' };
    const body = await pageOf(
      ending({ respondWith: 'returnBinary', completionTitle: 'Yours', inputDataFieldName: 'data, other' }),
      { input: [{ json: {}, binary: { data: binary, other: { ...binary, fileName: 'b.txt' } } }] },
    );
    expect(body).toContain(data);
    expect(body).toContain('b.txt');
    expect(body).not.toContain('a</script>');
    expect(body).toContain('Yours');
  });

  it('Return Binary File without the named file says which', async () => {
    await expect(
      call(ending({ respondWith: 'returnBinary', inputDataFieldName: 'missing' })),
    ).rejects.toThrow('No binary data property "missing" was found');
  });
});

describe('later pages keep the trigger access', () => {
  const basic = (user: string, password: string) =>
    `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  const options = (headers: Record<string, string> = {}, method: 'GET' | 'POST' = 'GET'): CallOptions => ({
    method,
    headers,
    trigger: { authentication: 'basicAuth' },
    creds: { httpBasicAuth: { user: 'me', password: 'pw' } },
  });

  it('asks for the login of the trigger, and the page holds a token for its submit', async () => {
    const refused = await call(textField, options());
    expect(refused.webhookResponse?.statusCode).toBe(401);
    expect(refused.webhookResponse?.headers?.['www-authenticate']).toContain('Basic');

    const body = await pageOf(textField, options({ authorization: basic('me', 'pw') }));
    expect(body).toContain('"authToken":"tok-1"');
  });

  it('a submit needs the login or the token', async () => {
    const refused = await call(textField, options({ authorization: basic('me', 'bad') }, 'POST'));
    expect(refused.webhookResponse?.statusCode).toBe(401);
    expect(refused.workflowData).toBeUndefined();
    const allowed = await call(textField, options({ authorization: basic('me', 'pw') }, 'POST'));
    expect(allowed.workflowData?.[0]?.[0]?.json).toHaveProperty('submittedAt');
  });

  it('asks the user auth of the trigger with the waiting scope, and adds the user', async () => {
    vi.mocked(checkFormUserAuth).mockResolvedValue({
      allowed: true,
      user: { id: 'u1', email: 'a@b.c', firstName: 'A', lastName: 'B' },
      headers: { 'set-cookie': 'ncb-form-auth-ex-e1=the-token; HttpOnly' },
    });
    const trigger = { authentication: 'n8nUserAuth', requireExecuteAccess: true };
    const page = await call(textField, { trigger });
    expect(checkFormUserAuth).toHaveBeenCalledWith(expect.anything(), {
      scope: 'waiting',
      requireExecuteAccess: true,
    });
    expect(String(page.webhookResponse?.body)).toContain('"authToken":"the-token"');
    expect(page.webhookResponse?.headers?.['set-cookie']).toContain('ncb-form-auth-ex-e1');

    const posted = await call(textField, { trigger, method: 'POST' });
    expect(posted.workflowData?.[0]?.[0]?.json.user).toMatchObject({ id: 'u1' });

    const without = await call(textField, {
      trigger: { ...trigger, options: { includeUserInOutput: false } },
      method: 'POST',
    });
    expect(without.workflowData?.[0]?.[0]?.json.user).toBeUndefined();
  });

  it('reads an expression of the trigger as its own page does', async () => {
    const user = { id: 'u1', email: 'a@b.c', firstName: 'A', lastName: 'B' };
    vi.mocked(checkFormUserAuth).mockResolvedValue({ allowed: true, user, headers: {} });
    const asked = async (requireExecuteAccess: unknown) => {
      vi.mocked(checkFormUserAuth).mockClear();
      await call(textField, { trigger: { authentication: 'n8nUserAuth', requireExecuteAccess } });
      return vi.mocked(checkFormUserAuth).mock.calls[0][1].requireExecuteAccess;
    };
    expect(await asked('={{ true }}')).toBe(true);
    expect(await asked('={{ false }}')).toBe(false);
    expect(await asked(true)).toBe(true);
    expect(await asked(undefined)).toBe(false);
    // an expression that fails refuses rather than lets everyone in
    expect(await asked('={{ $nodeThatIsNotThere.x }}')).toBe(true);

    const output = async (includeUserInOutput: unknown) =>
      (
        await call(textField, {
          trigger: { authentication: 'n8nUserAuth', options: { includeUserInOutput } },
          method: 'POST',
        })
      ).workflowData?.[0]?.[0]?.json.user;
    expect(await output('={{ false }}')).toBeUndefined();
    expect(await output('={{ $nodeThatIsNotThere.x }}')).toBeUndefined();
    expect(await output('={{ true }}')).toMatchObject({ id: 'u1' });
  });

  it('sends a visitor who is not allowed where the user auth says', async () => {
    vi.mocked(checkFormUserAuth).mockResolvedValue({
      allowed: false,
      headers: {},
      response: { statusCode: 302, headers: { location: '/signin' } },
    });
    const refused = await call(textField, { trigger: { authentication: 'n8nUserAuth' } });
    expect(refused.webhookResponse?.statusCode).toBe(302);
    expect(refused.webhookResponse?.headers?.location).toBe('/signin');
    expect(refused.workflowData).toBeUndefined();
  });
});

describe('Wait: On Form Submitted', () => {
  const wait = (parameters: DataObject = {}) => ({
    resume: 'form',
    formTitle: 'Approve',
    ...textField,
    ...parameters,
  });
  const respond = node('Reply', 'core.respondToWebhook', {}, [400, 0]);
  const options = (extra: CallOptions = {}): CallOptions => ({
    type: 'core.wait',
    noTrigger: true,
    ...extra,
  });

  it('Include User in Output off on the trigger keeps the user out of the output', async () => {
    const user = { id: 'u1', email: 'a@b.c', firstName: 'A', lastName: 'B' };
    vi.mocked(checkFormUserAuth).mockResolvedValue({ allowed: true, user, headers: {} });
    const output = async (triggerOptions: DataObject) =>
      (
        await call(wait(), {
          type: 'core.wait',
          method: 'POST',
          trigger: { authentication: 'n8nUserAuth', options: triggerOptions },
        })
      ).workflowData?.[0]?.[0]?.json.user;
    expect(await output({})).toMatchObject({ id: 'u1' });
    expect(await output({ includeUserInOutput: false })).toBeUndefined();
    expect(await output({ includeUserInOutput: '={{ false }}' })).toBeUndefined();
  });

  it('offers the option, its form parameters and the hooks', () => {
    const description = nodeTypes.get('core.wait')!.description;
    const resume = description.properties.find((p) => p.name === 'resume');
    expect(resume?.options?.map((o) => ('value' in o ? o.value : ''))).toContain('form');
    const names = description.properties.map((p) => p.name);
    for (const name of ['formTitle', 'formDescription', 'formFields', 'responseMode', 'authentication']) {
      expect(names).toContain(name);
    }
    expect(
      description.webhooks?.map((h) => [h.httpMethod.startsWith('=') ? 'any' : h.httpMethod, h.nodeType]),
    ).toEqual([
      ['any', undefined],
      ['GET', 'form'],
      ['POST', 'form'],
    ]);
  });

  it('waits, with the form URL in the metadata and the 307 only after a Form Trigger', async () => {
    const responses: WebhookResponse[] = [];
    const services: Partial<ExecutionServices> = {
      resumeFormUrl: FORM_URL,
      hooks: { sendResponse: (response) => responses.push(response) },
    };
    const page = node('Page', 'core.wait', wait(), [200, 0]);
    const plain = await runWorkflow(
      [node('Start', 'core.manualTrigger'), page],
      connect(['Start', 'Page']),
      undefined,
      { services },
    );
    expect(plain.status).toBe('waiting');
    expect(plain.runData.Page[0].metadata?.resumeFormUrl).toBe(FORM_URL);
    expect(responses).toEqual([]);

    const after = await runWorkflow(
      [node('Start', 'core.formTrigger', { formTitle: 'T' }), page],
      connect(['Start', 'Page']),
      undefined,
      { services },
    );
    expect(after.status).toBe('waiting');
    expect(responses).toEqual([{ statusCode: 307, headers: { location: FORM_URL } }]);
  });

  it('shows its form and gives the answers', async () => {
    const body = await pageOf(wait(), options());
    expect(body).toContain('Approve');
    expect(body).toContain('City');
    const result = await call(wait(), options({ method: 'POST', body: { 'field-0': 'Pune' } }));
    expect(result.workflowData?.[0]?.[0]?.json.City).toBe('Pune');
    expect(result.webhookResponse?.body).toEqual({ formSubmittedText: 'Your response has been recorded' });
  });

  it('its Form Response option names the text or the redirect', async () => {
    const text = await call(
      wait({
        options: { respondWithOptions: { values: { respondWith: 'text', formSubmittedText: 'Ok!' } } },
      }),
      options({ method: 'POST' }),
    );
    expect(text.webhookResponse?.body).toEqual({ formSubmittedText: 'Ok!' });
    const redirect = await call(
      wait({
        options: {
          respondWithOptions: { values: { respondWith: 'redirect', redirectUrl: 'https://a.example' } },
        },
      }),
      options({ method: 'POST' }),
    );
    expect(redirect.webhookResponse?.body).toEqual({ redirectURL: 'https://a.example/' });
  });

  it('has its own Basic auth', async () => {
    const parameters = wait({ authentication: 'basicAuth' });
    const creds = { httpBasicAuth: { user: 'me', password: 'pw' } };
    expect((await call(parameters, options({ creds }))).webhookResponse?.statusCode).toBe(401);
    const authorization = `Basic ${Buffer.from('me:pw').toString('base64')}`;
    const allowed = await call(parameters, options({ creds, headers: { authorization } }));
    expect(allowed.webhookResponse?.statusCode).toBe(200);
  });

  it('Using Respond to Webhook Node without one: n8n text, on the page and on a submit, and no run data', async () => {
    const parameters = wait({ responseMode: 'responseNode' });
    const shown = await pageOf(parameters, options());
    expect(shown).toContain('No Respond to Webhook node found in the workflow');
    const posted = await call(parameters, options({ method: 'POST' }));
    expect(posted.workflowData).toBeUndefined();
    expect(posted.webhookResponse?.body).toMatchObject({
      message: 'No Respond to Webhook node found in the workflow',
    });
  });

  it('A Respond to Webhook node that Respond When does not use: n8n text', async () => {
    const posted = await call(wait(), options({ method: 'POST', children: [respond] }));
    expect(posted.workflowData).toBeUndefined();
    expect(posted.webhookResponse?.body).toMatchObject({ message: 'Page node not correctly configured' });
  });

  it('Using Respond to Webhook Node with one takes the answers', async () => {
    const posted = await call(
      wait({ responseMode: 'responseNode' }),
      options({ method: 'POST', children: [respond], body: { 'field-0': 'Pune' } }),
    );
    expect(posted.workflowData?.[0]?.[0]?.json.City).toBe('Pune');
  });

  it('a plain webhook wait stays as it was', async () => {
    const result = await call({ resume: 'webhook' }, options({ method: 'POST', body: { a: 1 } }));
    expect(result.workflowData?.[0]?.[0]?.json.body).toEqual({ a: 1 });
  });

  it('a Form Trigger before it gives its auth too', async () => {
    const refused = await call(wait(), {
      type: 'core.wait',
      trigger: { authentication: 'basicAuth' },
      creds: { httpBasicAuth: { user: 'me', password: 'pw' } },
    });
    expect(refused.webhookResponse?.statusCode).toBe(401);
  });
});

describe('page scripts', () => {
  const base = {
    title: 'T',
    description: '',
    fields: [],
    buttonLabel: 'Go',
    testMode: false,
    attribution: false,
    submittedText: 'Done',
  };

  it('the form page polls the status and goes on, and only follows http or https', () => {
    const body = renderFormPage(base);
    expect(body).toContain('n8n-execution-status');
    expect(body).toContain('form-waiting');
    expect(body).toContain('formWaitingUrl');
    expect(body).toMatch(/https\?:/);
    expect(body).not.toContain('innerHTML');
  });

  it('the ending page sends one POST and writes no HTML from data', () => {
    const body = renderCompletionPage({
      pageTitle: 'T',
      title: 'A',
      message: 'B',
      attribution: false,
    });
    expect(body.match(/fetch\(/g)).toHaveLength(1);
    expect(body).not.toContain('innerHTML');
  });
});
