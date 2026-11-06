/** P4-01: the Form Trigger behind the real routes: production and test URLs, runs, replies, tokens. */
import type { DataObject, WorkflowNode } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FormTokenService } from '../src/services/form-tokens';
import {
  chain,
  createTestServer,
  createWorkflow,
  executionsOf,
  node,
  outputOf,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  waitFor,
  waitForExecution,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  // a small limit, so that the upload test stays small
  server = await createTestServer({ BODY_LIMIT_MB: '1' });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

// signup is limited per address
let signups = 0;
const owner = () =>
  signup(server.app, { remoteAddress: `10.9.${Math.floor(++signups / 200)}.${signups % 200}` });

const form = (parameters: DataObject = {}) =>
  node('Form', 'core.formTrigger', { formTitle: 'Sign up', path: 'sign-up', ...parameters });

const textField = { formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] } };

async function activeForm(
  client: Awaited<ReturnType<typeof signup>>['client'],
  nodes: WorkflowNode[],
  connections?: unknown,
  settings?: DataObject,
) {
  const wf = await createWorkflow(client, { nodes, connections, settings });
  await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
  return wf;
}

function multipart(fields: Record<string, string>, file?: { name: string; fileName: string; data: string }) {
  const boundary = 'F0RMB0UNDARY';
  const lines: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    lines.push(`--${boundary}`, `Content-Disposition: form-data; name="${name}"`, '', value);
  }
  if (file) {
    lines.push(
      `--${boundary}`,
      `Content-Disposition: form-data; name="${file.name}"; filename="${file.fileName}"`,
      'Content-Type: text/plain',
      '',
      file.data,
    );
  }
  lines.push(`--${boundary}--`, '');
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: lines.join('\r\n'),
  };
}

async function latestOutput(tenantId: string, workflowId: string, name: string) {
  const [execution] = await waitFor(async () => {
    const rows = await executionsOf(server.ctx, tenantId, workflowId);
    return rows.length ? rows : undefined;
  });
  await waitForExecution(server.ctx, tenantId, execution.id, ['success']);
  const data = await server.ctx.repos.executions.getData(tenantId, execution.id);
  return outputOf(data?.state, name);
}

describe('production form', () => {
  it('serves the page in the sandbox, with no cookie, and a submission starts a run with the answers', async () => {
    const { client, tenant } = await owner();
    const wf = await activeForm(client, [form(textField)]);

    const page = await server.app.inject({ method: 'GET', url: `/form/${tenant.slug}/sign-up` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain('sandbox');
    expect(page.headers['content-security-policy']).toContain('allow-scripts');
    expect(page.headers['content-security-policy']).not.toContain('allow-same-origin');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['set-cookie']).toBeUndefined();
    expect(page.body).toContain('Sign up');
    expect(await executionsOf(server.ctx, tenant.id, wf.id)).toHaveLength(0);

    const posted = await server.app.inject({
      method: 'POST',
      url: `/form/${tenant.slug}/sign-up?ref=mail`,
      ...multipart({ 'field-0': ' Ann ' }),
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.headers['content-security-policy']).toContain('sandbox');
    expect(posted.headers['set-cookie']).toBeUndefined();
    expect(posted.json()).toEqual({ formSubmittedText: 'Your response has been recorded' });

    const [output] = await latestOutput(tenant.id, wf.id, 'Form');
    expect(output).toMatchObject({
      Name: 'Ann',
      formMode: 'production',
      formQueryParameters: { ref: 'mail' },
    });
    expect(Number.isNaN(Date.parse(String(output.submittedAt)))).toBe(false);
  });

  it('labels the button', async () => {
    const { client, tenant } = await owner();
    await activeForm(client, [form({ options: { buttonLabel: 'Send it' } })]);
    const page = await server.app.inject({ method: 'GET', url: `/form/${tenant.slug}/sign-up` });
    expect(page.body).toContain('>Send it</button>');
  });

  it('serves the Form Path option, and the node id without a path', async () => {
    const { client, tenant } = await owner();
    await activeForm(client, [
      node('A', 'core.formTrigger', { formTitle: 'Option', options: { path: 'by-option' } }),
    ]);
    const byOption = await server.app.inject({ method: 'GET', url: `/form/${tenant.slug}/by-option` });
    expect(byOption.statusCode).toBe(200);
    expect(byOption.body).toContain('Option');

    const bare = node('B', 'core.formTrigger', { formTitle: 'Bare' });
    await activeForm(client, [bare]);
    const byId = await server.app.inject({ method: 'GET', url: `/form/${tenant.slug}/${bare.id}` });
    expect(byId.statusCode).toBe(200);
    expect(byId.body).toContain('Bare');
  });

  it('puts the workflow timezone on submittedAt, unless turned off', async () => {
    const { client, tenant } = await owner();
    const zoned = await activeForm(client, [form()], undefined, { timezone: 'Asia/Kolkata' });
    await server.app.inject({ method: 'POST', url: `/form/${tenant.slug}/sign-up`, ...multipart({}) });
    const [first] = await latestOutput(tenant.id, zoned.id, 'Form');
    expect(String(first.submittedAt)).toMatch(/\+05:30$/);

    const utc = await activeForm(
      client,
      [
        node('U', 'core.formTrigger', {
          formTitle: 'U',
          path: 'utc',
          options: { useWorkflowTimezone: false },
        }),
      ],
      undefined,
      { timezone: 'Asia/Kolkata' },
    );
    await server.app.inject({ method: 'POST', url: `/form/${tenant.slug}/utc`, ...multipart({}) });
    const [second] = await latestOutput(tenant.id, utc.id, 'U');
    expect(String(second.submittedAt)).toMatch(/Z$/);
  });

  it('Show Headers leaves out the three sensitive headers', async () => {
    const { client, tenant } = await owner();
    const wf = await activeForm(client, [form({ options: { showHeaders: true } })]);
    const parts = multipart({});
    await server.app.inject({
      method: 'POST',
      url: `/form/${tenant.slug}/sign-up`,
      payload: parts.payload,
      headers: {
        ...parts.headers,
        'x-keep': 'kept',
        authorization: 'Basic abc',
        cookie: 'a=b',
        'x-auth-token': 'tok',
      },
    });
    const [output] = await latestOutput(tenant.id, wf.id, 'Form');
    const headers = output.headers as DataObject;
    expect(headers['x-keep']).toBe('kept');
    for (const name of ['authorization', 'cookie', 'x-auth-token']) expect(headers).not.toHaveProperty(name);
  });

  it('renders a Custom HTML field and the description once, a prefilled {{ 1+1 }} and $& stay literal', async () => {
    const { client, tenant } = await owner();
    const wf = await activeForm(client, [
      form({
        formDescription: '<b>{{ 1+1 }} $&</b>',
        formFields: {
          values: [
            { fieldType: 'html', html: '<p>sum {{ 1+1 }} $&</p>' },
            { fieldLabel: 'Name', fieldType: 'text' },
          ],
        },
      }),
    ]);
    const value = encodeURIComponent('{{ 1+1 }} $&');
    const page = await server.app.inject({
      method: 'GET',
      url: `/form/${tenant.slug}/sign-up?Name=${value}`,
    });
    expect(page.body).toContain('<b>{{ 1+1 }} $&amp;</b>');
    expect(page.body).toContain('<p>sum 2 $&amp;</p>');
    expect(page.body).toContain('value="{{ 1+1 }} $&amp;"');

    await server.app.inject({
      method: 'POST',
      url: `/form/${tenant.slug}/sign-up`,
      ...multipart({ 'field-1': '{{ 1+1 }} $&' }),
    });
    const [output] = await latestOutput(tenant.id, wf.id, 'Form');
    expect(output.Name).toBe('{{ 1+1 }} $&');
  });

  it('stores an uploaded file on the run', async () => {
    const { client, tenant } = await owner();
    const wf = await activeForm(client, [
      form({ formFields: { values: [{ fieldLabel: 'Doc', fieldType: 'file' }] } }),
    ]);
    await server.app.inject({
      method: 'POST',
      url: `/form/${tenant.slug}/sign-up`,
      ...multipart({}, { name: 'field-0', fileName: 'a.txt', data: 'hello' }),
    });
    const [output] = await latestOutput(tenant.id, wf.id, 'Form');
    expect(output.Doc).toEqual([{ filename: 'a.txt', mimetype: 'text/plain', size: 5 }]);
  });

  it('answers an upload over the body limit with the text the page shows', async () => {
    const { client, tenant } = await owner();
    await activeForm(client, [form({ formFields: { values: [{ fieldLabel: 'Doc', fieldType: 'file' }] } })]);
    const res = await server.app.inject({
      method: 'POST',
      url: `/form/${tenant.slug}/sign-up`,
      ...multipart({}, { name: 'field-0', fileName: 'a.txt', data: 'x'.repeat(1024 * 1024 + 10) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.json().error.message).toBe(
      'The files you are trying to upload are too large. Please reduce the total size and try again.',
    );
  });

  it('a run that answers when it finishes holds the reply until the end', async () => {
    const { client, tenant } = await owner();
    const wf = await activeForm(
      client,
      [form({ responseMode: 'lastNode' }), setNode('Set', 'done', 'yes')],
      chain('Form', 'Set'),
    );
    const res = await server.app.inject({
      method: 'POST',
      url: `/form/${tenant.slug}/sign-up`,
      ...multipart({}),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    const [execution] = await executionsOf(server.ctx, tenant.id, wf.id);
    expect(execution.status).toBe('success');
  });

  it('refuses a workflow with a Respond to Webhook node', async () => {
    const { client, tenant } = await owner();
    const wf = await activeForm(
      client,
      [form(), node('Respond', 'core.respondToWebhook', {}, [200, 0])],
      chain('Form', 'Respond'),
    );
    const page = await server.app.inject({ method: 'GET', url: `/form/${tenant.slug}/sign-up` });
    expect(page.statusCode).toBe(409);
    expect(page.body).toContain('Respond to Webhook');
    const posted = await server.app.inject({
      method: 'POST',
      url: `/form/${tenant.slug}/sign-up`,
      ...multipart({}),
    });
    expect(posted.statusCode).toBe(409);
    expect(await executionsOf(server.ctx, tenant.id, wf.id)).toHaveLength(0);
  });

  it('checks the IP allowlist with a CIDR', async () => {
    const { client, tenant } = await owner();
    await activeForm(client, [form({ options: { ipWhitelist: '10.0.0.0/8' } })]);
    const refused = await server.app.inject({
      method: 'GET',
      url: `/form/${tenant.slug}/sign-up`,
      remoteAddress: '11.0.0.1',
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain('IP is not allowed to access this form!');
    const allowed = await server.app.inject({
      method: 'GET',
      url: `/form/${tenant.slug}/sign-up`,
      remoteAddress: '10.0.0.1',
    });
    expect(allowed.statusCode).toBe(200);
  });
});

describe('URL families', () => {
  it('/webhook never serves a form hook, /form never serves a webhook', async () => {
    const { client, tenant } = await owner();
    await activeForm(client, [
      form(),
      node('Hook', 'core.webhook', { path: 'orders', httpMethod: 'POST' }, [0, 200]),
    ]);
    for (const [method, url] of [
      ['GET', `/webhook/${tenant.slug}/sign-up`],
      ['POST', `/webhook/${tenant.slug}/sign-up`],
      ['POST', `/form/${tenant.slug}/orders`],
    ] as const) {
      const res = await server.app.inject({ method, url });
      expect(res.statusCode, url).toBe(404);
    }
    const answered = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/orders`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(answered.statusCode).toBe(200);
  });

  it('the test URLs keep the families apart too, and leave the registration in place', async () => {
    const { client, tenant } = await owner();
    const wf = await createWorkflow(client, { nodes: [form()] });
    await client.data(client.post(`/rest/workflows/${wf.id}/listen-test-webhook`, { nodeName: 'Form' }));
    const wrong = await server.app.inject({ method: 'GET', url: `/webhook-test/${tenant.slug}/sign-up` });
    expect(wrong.statusCode).toBe(404);
    const right = await server.app.inject({ method: 'GET', url: `/form-test/${tenant.slug}/sign-up` });
    expect(right.statusCode).toBe(200);
  });
});

describe('test form', () => {
  it('a GET keeps the registration, the POST uses it up for both hooks', async () => {
    const { client, tenant } = await owner();
    const wf = await createWorkflow(client, { nodes: [form(textField)] });
    await client.data(client.post(`/rest/workflows/${wf.id}/listen-test-webhook`, { nodeName: 'Form' }));
    const url = `/form-test/${tenant.slug}/sign-up`;

    for (let i = 0; i < 2; i++) {
      const page = await server.app.inject({ method: 'GET', url });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('This is a test version of your form');
    }
    expect(await executionsOf(server.ctx, tenant.id, wf.id)).toHaveLength(0);

    const posted = await server.app.inject({ method: 'POST', url, ...multipart({ 'field-0': 'Ann' }) });
    expect(posted.statusCode).toBe(200);
    const [output] = await latestOutput(tenant.id, wf.id, 'Form');
    expect(output).toMatchObject({ Name: 'Ann', formMode: 'test' });

    expect((await server.app.inject({ method: 'GET', url })).statusCode).toBe(404);
    expect((await server.app.inject({ method: 'POST', url, ...multipart({}) })).statusCode).toBe(404);
  });

  it('a browser gets the page that says what to do, a script the JSON', async () => {
    const { tenant } = await owner();
    const url = `/form-test/${tenant.slug}/sign-up`;
    const page = await server.app.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
    expect(page.statusCode).toBe(404);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain('sandbox');
    expect(page.body).toContain('Form Trigger isn&#39;t listening yet');

    const api = await server.app.inject({ method: 'GET', url });
    expect(api.statusCode).toBe(404);
    expect(api.json().error.message).toContain('Listen for test event');
  });
});

describe('production error page', () => {
  it('a browser gets the page, a script the JSON', async () => {
    const { client, tenant } = await owner();
    await createWorkflow(client, { nodes: [form()] });
    const url = `/form/${tenant.slug}/sign-up`;
    const page = await server.app.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
    expect(page.statusCode).toBe(404);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain('sandbox');
    expect(page.body).toContain('Problem loading form');
    const api = await server.app.inject({ method: 'GET', url });
    expect(api.json().error.message).toContain('is not registered');
  });
});

describe('a form that fails', () => {
  it('shows a browser the fixed text, in the sandbox', async () => {
    const { client, tenant } = await owner();
    await activeForm(client, [form({ formTitle: '={{ $nope.x }}' })]);
    const url = `/form/${tenant.slug}/sign-up`;
    const page = await server.app.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
    expect(page.statusCode).toBe(500);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain('sandbox');
    expect(page.body).toContain('The webhook could not be processed');
    expect(page.body).not.toContain('nope');
    const api = await server.app.inject({ method: 'GET', url });
    expect(api.json().error.code).toBe('webhook_error');
  });
});

describe('preflight', () => {
  it('answers the sandboxed page, whose Origin is null, for its x-auth-token', async () => {
    const { client, tenant } = await owner();
    await activeForm(client, [form()]);
    const res = await server.app.inject({
      method: 'OPTIONS',
      url: `/form/${tenant.slug}/sign-up`,
      headers: {
        origin: 'null',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-auth-token',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-headers']).toBe('x-auth-token');
    expect(String(res.headers['access-control-allow-methods'])).toContain('POST');
  });

  it('the POST of a sandboxed page can read its answer', async () => {
    const { client, tenant } = await owner();
    await activeForm(client, [form()]);
    const parts = multipart({});
    const res = await server.app.inject({
      method: 'POST',
      url: `/form/${tenant.slug}/sign-up`,
      payload: parts.payload,
      headers: { ...parts.headers, origin: 'null' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('Basic auth', () => {
  const authHeader = `Basic ${Buffer.from('ann:secret').toString('base64')}`;

  async function basicForm() {
    const member = await owner();
    const credential = await member.client.data<{ id: string }>(
      member.client.post('/rest/credentials', {
        name: 'Form login',
        type: 'httpBasicAuth',
        data: { user: 'ann', password: 'secret' },
      }),
    );
    const wf = await activeForm(member.client, [
      node(
        'Form',
        'core.formTrigger',
        { formTitle: 'Private', path: 'private', authentication: 'basicAuth' },
        [0, 0],
        { credentials: { httpBasicAuth: { id: credential.id, name: 'Form login' } } },
      ),
    ]);
    return { ...member, wf, url: `/form/${member.tenant.slug}/private` };
  }

  it("asks for the login, and the page's token lets the POST through", async () => {
    const { tenant, wf, url } = await basicForm();
    const anonymous = await server.app.inject({ method: 'GET', url });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['www-authenticate']).toBe('Basic realm="Enter credentials"');

    const page = await server.app.inject({ method: 'GET', url, headers: { authorization: authHeader } });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain('secret');
    const token = /"authToken":"([^"]+)"/.exec(page.body)?.[1];
    expect(token).toBeTruthy();

    const parts = multipart({});
    const refused = await server.app.inject({ method: 'POST', url, ...parts });
    expect(refused.statusCode).toBe(401);

    const posted = await server.app.inject({
      method: 'POST',
      url,
      payload: parts.payload,
      headers: { ...parts.headers, 'x-auth-token': token! },
    });
    expect(posted.statusCode).toBe(200);
    const [output] = await latestOutput(tenant.id, wf.id, 'Form');
    expect(JSON.stringify(output)).not.toContain(token);
  });

  it('a token of one workspace opens nothing in another', async () => {
    const first = await basicForm();
    const page = await server.app.inject({
      method: 'GET',
      url: first.url,
      headers: { authorization: authHeader },
    });
    const token = /"authToken":"([^"]+)"/.exec(page.body)?.[1];
    const second = await basicForm();
    const parts = multipart({});
    const res = await server.app.inject({
      method: 'POST',
      url: second.url,
      payload: parts.payload,
      headers: { ...parts.headers, 'x-auth-token': token! },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('FormTokenService', () => {
  const service = () => server.ctx.formTokens as FormTokenService;

  it('gives the payload back', () => {
    const token = service().sign({ tenantId: 't', n: 1 }, 60);
    expect(service().verify(token)).toEqual({ tenantId: 't', n: 1 });
  });

  it('refuses a forged signature and a changed payload', () => {
    const token = service().sign({ tenantId: 't' }, 60);
    const [body, signature] = token.split('.');
    expect(service().verify(`${body}.${signature.slice(0, -2)}xx`)).toBeNull();
    const other = Buffer.from(JSON.stringify({ tenantId: 'other', exp: 9_999_999_999 })).toString(
      'base64url',
    );
    expect(service().verify(`${other}.${signature}`)).toBeNull();
  });

  it('refuses an expired token', () => {
    expect(service().verify(service().sign({ a: 1 }, -1))).toBeNull();
  });

  it('a payload cannot choose its own expiry', () => {
    expect(service().verify(service().sign({ exp: 9_999_999_999 }, -1))).toBeNull();
  });

  it('refuses what is not a token', () => {
    for (const bad of ['', 'x', 'a.b.c', '.', `${'a'.repeat(5000)}.b`]) {
      expect(service().verify(bad), bad).toBeNull();
    }
  });

  it('holds a token of the old key after a rotation, not one of a stranger', () => {
    const old = service().sign({ a: 1 }, 60);
    const config = server.ctx.config;
    const newKey = { id: 'new', key: Buffer.alloc(32, 9) };
    const rotated = new FormTokenService({
      ...(service().deps as object),
      config: { ...config, encryptionKeys: [newKey, ...config.encryptionKeys] },
    } as never);
    expect(rotated.verify(old)).toEqual({ a: 1 });
    expect(service().verify(rotated.sign({ a: 1 }, 60))).toBeNull();
  });
});
