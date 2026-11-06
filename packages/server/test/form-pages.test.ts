/** P4-02: multi-page forms behind the real routes: /form-waiting, the status suffix, endings, Wait forms. */
import type { DataObject, WorkflowNode } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  server = await createTestServer({ BODY_LIMIT_MB: '1' });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

let signups = 0;
const owner = () =>
  signup(server.app, { remoteAddress: `10.8.${Math.floor(++signups / 200)}.${signups % 200}` });

const trigger = (parameters: DataObject = {}) =>
  node('Start', 'core.formTrigger', {
    formTitle: 'Sign up',
    path: 'sign-up',
    formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] },
    ...parameters,
  });

const page = (name: string, label: string, parameters: DataObject = {}, x = 200) =>
  node(
    name,
    'core.form',
    { operation: 'page', formFields: { values: [{ fieldLabel: label, fieldType: 'text' }] }, ...parameters },
    [x, 0],
  );

const ending = (name: string, parameters: DataObject = {}, x = 400) =>
  node(name, 'core.form', { operation: 'completion', ...parameters }, [x, 0]);

function multipart(fields: Record<string, string>) {
  const boundary = 'F0RMB0UNDARY';
  const lines: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    lines.push(`--${boundary}`, `Content-Disposition: form-data; name="${name}"`, '', value);
  }
  lines.push(`--${boundary}--`, '');
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: lines.join('\r\n'),
  };
}

async function active(
  client: Awaited<ReturnType<typeof signup>>['client'],
  nodes: WorkflowNode[],
  connections: unknown,
) {
  const wf = await createWorkflow(client, { nodes, connections });
  await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
  return wf;
}

const pathOf = (url: string) => new URL(url).pathname;
const get = (url: string, headers: Record<string, string> = {}) =>
  server.app.inject({ method: 'GET', url, headers });
const post = (url: string, fields: Record<string, string> = {}, headers: Record<string, string> = {}) => {
  const form = multipart(fields);
  return server.app.inject({
    method: 'POST',
    url,
    payload: form.payload,
    headers: { ...form.headers, ...headers },
  });
};

/** polls like the page does, until the run stands at a form page */
const atFormPage = (url: string) =>
  waitFor(async () => {
    const res = await get(`${url}/n8n-execution-status`);
    return res.body === 'form-waiting' ? res : undefined;
  });

/** submits the trigger; the path of the next page */
async function submitTrigger(slug: string, fields: Record<string, string> = { 'field-0': 'Ann' }) {
  const res = await post(`/form/${slug}/sign-up`, fields);
  expect(res.statusCode).toBe(200);
  const url = pathOf(res.json().formWaitingUrl);
  await atFormPage(url);
  return url;
}

describe('a two-page form', () => {
  it('the workflow gets the answers of both pages', async () => {
    const { client, tenant } = await owner();
    const wf = await active(
      client,
      [
        trigger(),
        page('Second', 'City'),
        ending('End', { respondWith: 'text', completionTitle: 'All done', completionMessage: 'Bye' }),
        setNode('After', 'done', 'yes', [600, 0]),
      ],
      chain('Start', 'Second', 'End', 'After'),
    );

    const url = await submitTrigger(tenant.slug);
    const [execution] = await executionsOf(server.ctx, tenant.id, wf.id);
    expect(execution.status).toBe('waiting');
    expect(url).toContain(`/form-waiting/${execution.id}/`);

    const shown = await get(url);
    expect(shown.statusCode).toBe(200);
    expect(shown.headers['content-type']).toContain('text/html');
    expect(shown.headers['content-security-policy']).toContain('sandbox');
    expect(shown.headers['content-security-policy']).not.toContain('allow-same-origin');
    expect(shown.headers['x-content-type-options']).toBe('nosniff');
    expect(shown.headers['set-cookie']).toBeUndefined();
    expect(shown.body).toContain('City');
    expect(shown.body).toContain('Sign up');
    // showing a page resumes nothing
    expect((await server.ctx.repos.executions.get(tenant.id, execution.id))?.status).toBe('waiting');

    const second = await post(url, { 'field-0': 'Pune' });
    expect(second.statusCode).toBe(200);
    // a 3xx from a form page is an answer the page can read; the run already stands at the next page
    expect(pathOf(second.json().redirectURL)).toBe(url);
    expect(second.headers.location).toBeUndefined();
    expect((await get(`${url}/n8n-execution-status`)).body).toBe('form-waiting');

    const end = await get(url);
    expect(end.statusCode).toBe(200);
    expect(end.body).toContain('All done');
    expect(end.body).toContain('Bye');

    const finished = await post(url);
    expect(finished.statusCode).toBe(200);
    await waitForExecution(server.ctx, tenant.id, execution.id, ['success']);
    const data = await server.ctx.repos.executions.getData(tenant.id, execution.id);
    expect(outputOf(data?.state, 'Start')[0]).toMatchObject({ Name: 'Ann', formMode: 'production' });
    expect(outputOf(data?.state, 'Second')[0]).toMatchObject({ City: 'Pune', formMode: 'production' });
    expect(outputOf(data?.state, 'After')[0]).toMatchObject({ done: 'yes' });

    expect((await get(`${url}/n8n-execution-status`)).body).toBe('success');
    const again = await get(url);
    expect(again.statusCode).toBe(200);
    expect(again.body).toContain('Form Submitted');
    expect(again.body).toContain('Your response has been recorded');
  });

  it('with no ending, the last page ends the run and the page shows its text', async () => {
    const { client, tenant } = await owner();
    const wf = await active(client, [trigger(), page('Second', 'City')], chain('Start', 'Second'));
    const url = await submitTrigger(tenant.slug);
    const res = await post(url, { 'field-0': 'Pune' });
    expect(res.statusCode).toBe(200);
    expect(res.json().redirectURL).toBeUndefined();
    const [execution] = await executionsOf(server.ctx, tenant.id, wf.id);
    await waitForExecution(server.ctx, tenant.id, execution.id, ['success']);
    expect((await get(`${url}/n8n-execution-status`)).body).toBe('success');
  });

  it('a test run goes through the same pages at /form-test', async () => {
    const { client, tenant } = await owner();
    const wf = await createWorkflow(client, {
      nodes: [trigger(), page('Second', 'City'), ending('End')],
      connections: chain('Start', 'Second', 'End'),
    });
    await client.data(client.post(`/rest/workflows/${wf.id}/listen-test-webhook`, { nodeName: 'Start' }));
    expect((await get(`/form-test/${tenant.slug}/sign-up`)).statusCode).toBe(200);
    const res = await post(`/form-test/${tenant.slug}/sign-up`, { 'field-0': 'Ann' });
    const url = pathOf(res.json().formWaitingUrl);
    await atFormPage(url);
    const shown = await get(url);
    expect(shown.body).toContain('This is a test version of your form');
    await post(url, { 'field-0': 'Pune' });
    await post(url);
    const [execution] = await executionsOf(server.ctx, tenant.id, wf.id);
    await waitForExecution(server.ctx, tenant.id, execution.id, ['success']);
    const data = await server.ctx.repos.executions.getData(tenant.id, execution.id);
    expect(outputOf(data?.state, 'Second')[0]).toMatchObject({ City: 'Pune', formMode: 'test' });
    const state = data?.state as { resultData: { runData: DataObject } } | null | undefined;
    expect(state?.resultData.runData).toHaveProperty('End');
  });

  it('a slow step between pages: the page polls until the next page stands', async () => {
    const { client, tenant } = await owner();
    await active(
      client,
      [
        trigger(),
        node('Pause', 'core.wait', { resume: 'timeInterval', amount: 1, unit: 'seconds' }, [100, 0]),
        page('Second', 'City'),
      ],
      chain('Start', 'Pause', 'Second'),
    );
    const res = await post(`/form/${tenant.slug}/sign-up`, { 'field-0': 'Ann' });
    const url = pathOf(res.json().formWaitingUrl);
    const first = await get(`${url}/n8n-execution-status`);
    expect(['new', 'running', 'form-waiting']).toContain(first.body);
    await atFormPage(url);
    expect((await get(url)).body).toContain('City');
  });
});

describe('expressions in HTML fields of a later page', () => {
  const html = (text: string) => ({ formFields: { values: [{ fieldType: 'html', html: text }] } });

  async function shownWith(name: string) {
    const { client, tenant } = await owner();
    await active(
      client,
      [trigger(), page('Second', '', html('=<h2>{{ $input.first().json.Name }}</h2>'))],
      chain('Start', 'Second'),
    );
    const url = await submitTrigger(tenant.slug, { 'field-0': name });
    return (await get(url)).body;
  }

  it('a submitted {{ 1+1 }} renders literally', async () => {
    const body = await shownWith('{{ 1+1 }}');
    expect(body).toContain('<h2>{{ 1+1 }}</h2>');
    expect(body).not.toContain('<h2>2</h2>');
  });

  it('a submitted $& renders unchanged', async () => {
    expect(await shownWith('$&')).toContain('<h2>$&amp;</h2>');
  });
});

describe('the resume URL', () => {
  async function waitingForm() {
    const { client, tenant } = await owner();
    const wf = await active(client, [trigger(), page('Second', 'City')], chain('Start', 'Second'));
    const url = await submitTrigger(tenant.slug);
    const [execution] = await executionsOf(server.ctx, tenant.id, wf.id);
    return { tenant, url, execution };
  }

  it('a wrong signature knows nothing, and a browser gets a page', async () => {
    const { execution } = await waitingForm();
    const base = `/form-waiting/${execution.id}/forged`;
    expect((await get(base)).statusCode).toBe(404);
    expect((await get(base)).json().error.message).toBe('Execution not found');
    expect((await get(`${base}/n8n-execution-status`)).statusCode).toBe(404);
    expect((await post(base)).statusCode).toBe(404);
    const browser = await get(base, { accept: 'text/html' });
    expect(browser.statusCode).toBe(404);
    expect(browser.headers['content-type']).toContain('text/html');
    expect((await server.app.inject({ method: 'OPTIONS', url: base })).statusCode).toBe(404);
  });

  it('a form page does not resume at /webhook-waiting, nor a webhook wait at /form-waiting', async () => {
    const { tenant, url, execution } = await waitingForm();
    const hook = url.replace('/form-waiting/', '/webhook-waiting/');
    expect((await post(hook, { 'field-0': 'x' })).statusCode).toBe(404);
    expect((await server.ctx.repos.executions.get(tenant.id, execution.id))?.status).toBe('waiting');

    const other = await owner();
    const wf = await active(
      other.client,
      [
        node('Hook', 'core.webhook', { httpMethod: 'POST', path: 'in' }, [0, 0], { webhookId: 'in' }),
        node('Wait', 'core.wait', { resume: 'webhook' }, [200, 0]),
      ],
      chain('Hook', 'Wait'),
    );
    await server.app.inject({ method: 'POST', url: `/webhook/${other.tenant.slug}/in`, payload: {} });
    const [waiting] = await waitFor(async () => {
      const rows = await executionsOf(server.ctx, other.tenant.id, wf.id);
      return rows[0]?.status === 'waiting' ? rows : undefined;
    });
    const form = pathOf(server.ctx.executions.resumeFormUrl(waiting.id));
    expect((await get(form)).statusCode).toBe(404);
    expect((await post(form)).statusCode).toBe(404);
    expect((await get(`${form}/n8n-execution-status`)).body).toBe('waiting');
    expect((await server.ctx.repos.executions.get(other.tenant.id, waiting.id))?.status).toBe('waiting');
  });

  it('answers the preflight of the sandboxed page, and every answer can be read from it', async () => {
    const { url } = await waitingForm();
    const origin = { origin: 'null' };
    const preflight = await server.app.inject({
      method: 'OPTIONS',
      url,
      headers: {
        ...origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-auth-token',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('*');
    expect(preflight.headers['access-control-allow-headers']).toBe('x-auth-token');
    expect(preflight.headers['access-control-allow-methods']).toContain('POST');

    const status = await get(`${url}/n8n-execution-status`, origin);
    expect(status.headers['access-control-allow-origin']).toBe('*');
    expect(status.headers['content-security-policy']).toContain('sandbox');
    const answer = await post(url, { 'field-0': 'Pune' }, origin);
    expect(answer.headers['access-control-allow-origin']).toBe('*');
  });

  it('a page cannot be submitted twice', async () => {
    const { url } = await waitingForm();
    expect((await post(url, { 'field-0': 'Pune' })).statusCode).toBe(200);
    const again = await post(url, { 'field-0': 'Other' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('not_waiting');
  });

  it('an upload over the limit keeps the run waiting, with the form text', async () => {
    const { tenant, url, execution } = await waitingForm();
    const boundary = 'F0RMB0UNDARY';
    const res = await server.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, origin: 'null' },
      payload: [
        `--${boundary}`,
        'Content-Disposition: form-data; name="field-0"; filename="big.txt"',
        'Content-Type: text/plain',
        '',
        'x'.repeat(2 * 1024 * 1024),
        `--${boundary}--`,
        '',
      ].join('\r\n'),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.message).toContain('too large');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect((await server.ctx.repos.executions.get(tenant.id, execution.id))?.status).toBe('waiting');
  });

  it('a failed run shows no form', async () => {
    const { client, tenant } = await owner();
    const wf = await active(
      client,
      [
        trigger(),
        node('Boom', 'core.stopAndError', { errorMessage: 'stop' }, [100, 0]),
        page('Second', 'City'),
      ],
      chain('Start', 'Boom', 'Second'),
    );
    const res = await post(`/form/${tenant.slug}/sign-up`, { 'field-0': 'Ann' });
    const url = pathOf(res.json().formWaitingUrl);
    const [execution] = await waitFor(async () => {
      const rows = await executionsOf(server.ctx, tenant.id, wf.id);
      return rows.length ? rows : undefined;
    });
    await waitForExecution(server.ctx, tenant.id, execution.id, ['error']);
    expect((await get(`${url}/n8n-execution-status`)).body).toBe('error');
    const shown = await get(url, { accept: 'text/html' });
    expect(shown.statusCode).toBe(409);
    expect(shown.body).toContain('Problem loading form');
    expect(shown.body).not.toContain('Your response has been recorded');
  });
});

describe('endings', () => {
  async function endingPage(parameters: DataObject) {
    const { client, tenant } = await owner();
    await active(client, [trigger(), ending('End', parameters, 200)], chain('Start', 'End'));
    return submitTrigger(tenant.slug);
  }

  it('Redirect to URL names the URL for the page to go to', async () => {
    const url = await endingPage({ respondWith: 'redirect', redirectUrl: 'https://example.com/done' });
    expect((await get(url)).body).toContain('https://example.com/done');
  });

  it('Show Text', async () => {
    const url = await endingPage({
      respondWith: 'showText',
      responseText: '<b>Thanks</b><script>x()</script>',
    });
    const body = (await get(url)).body;
    expect(body).toContain('<b>Thanks</b>');
    expect(body).not.toContain('x()');
  });

  it('Return Binary File', async () => {
    const { client, tenant } = await owner();
    await active(
      client,
      [
        node(
          'Start',
          'core.formTrigger',
          {
            formTitle: 'Upload',
            path: 'sign-up',
            formFields: { values: [{ fieldLabel: 'data', fieldType: 'file' }] },
          },
          [0, 0],
        ),
        ending('End', { respondWith: 'returnBinary', inputDataFieldName: 'data' }, 200),
      ],
      chain('Start', 'End'),
    );
    const boundary = 'F0RMB0UNDARY';
    const res = await server.app.inject({
      method: 'POST',
      url: `/form/${tenant.slug}/sign-up`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: [
        `--${boundary}`,
        'Content-Disposition: form-data; name="field-0"; filename="note.txt"',
        'Content-Type: text/plain',
        '',
        'hello',
        `--${boundary}--`,
        '',
      ].join('\r\n'),
    });
    const url = pathOf(res.json().formWaitingUrl);
    await atFormPage(url);
    const body = (await get(url)).body;
    expect(body).toContain('note.txt');
    expect(body).toContain(Buffer.from('hello').toString('base64'));
  });
});

describe('Basic auth on later pages', () => {
  it('asks for the trigger login, and the submit carries the page token', async () => {
    const { client, tenant } = await owner();
    const credential = await client.data<{ id: string; name: string }>(
      client.post('/rest/credentials', {
        name: 'Login',
        type: 'httpBasicAuth',
        data: { user: 'me', password: 'pw' },
      }),
    );
    await active(
      client,
      [
        node(
          'Start',
          'core.formTrigger',
          { formTitle: 'T', path: 'sign-up', authentication: 'basicAuth' },
          [0, 0],
          {
            credentials: { httpBasicAuth: { id: credential.id, name: credential.name } },
          },
        ),
        page('Second', 'City'),
      ],
      chain('Start', 'Second'),
    );
    const authorization = `Basic ${Buffer.from('me:pw').toString('base64')}`;
    const res = await post(`/form/${tenant.slug}/sign-up`, {}, { authorization });
    const url = pathOf(res.json().formWaitingUrl);
    await atFormPage(url);

    const refused = await get(url);
    expect(refused.statusCode).toBe(401);
    expect(refused.headers['www-authenticate']).toContain('Basic');
    expect((await post(url, { 'field-0': 'x' })).statusCode).toBe(401);

    const shown = await get(url, { authorization });
    expect(shown.statusCode).toBe(200);
    const token = /"authToken":"([^"]+)"/.exec(shown.body)?.[1] as string;
    expect(token).toBeTruthy();
    expect((await post(url, { 'field-0': 'x' }, { 'x-auth-token': token })).statusCode).toBe(200);
  });
});

describe('Wait: On Form Submitted', () => {
  const waitForm = (parameters: DataObject = {}) =>
    node(
      'Wait',
      'core.wait',
      {
        resume: 'form',
        formTitle: 'Approve',
        formFields: { values: [{ fieldLabel: 'Ok', fieldType: 'text' }] },
        ...parameters,
      },
      [200, 0],
    );
  const webhook = (parameters: DataObject = {}) =>
    node('Hook', 'core.webhook', { httpMethod: 'POST', path: 'in', ...parameters }, [0, 0], {
      webhookId: 'in',
    });

  async function waiting(nodes: WorkflowNode[], names: string[]) {
    const { client, tenant } = await owner();
    const wf = await active(client, nodes, chain(...names));
    await server.app.inject({ method: 'POST', url: `/webhook/${tenant.slug}/in`, payload: {} });
    const [execution] = await waitFor(async () => {
      const rows = await executionsOf(server.ctx, tenant.id, wf.id);
      return rows[0]?.status === 'waiting' ? rows : undefined;
    });
    return { tenant, execution, url: pathOf(server.ctx.executions.resumeFormUrl(execution.id)) };
  }

  it('a form answered with the default text resumes the run with the answers', async () => {
    const { tenant, execution, url } = await waiting([webhook(), waitForm()], ['Hook', 'Wait']);
    const shown = await get(url);
    expect(shown.statusCode).toBe(200);
    expect(shown.body).toContain('Approve');
    const res = await post(url, { 'field-0': 'yes' });
    expect(res.json()).toEqual({ formSubmittedText: 'Your response has been recorded' });
    await waitForExecution(server.ctx, tenant.id, execution.id, ['success']);
    const data = await server.ctx.repos.executions.getData(tenant.id, execution.id);
    expect(outputOf(data?.state, 'Wait')[0]).toMatchObject({ Ok: 'yes' });
  });

  it('a Wait form answered by a Respond to Webhook node', async () => {
    const { tenant, execution, url } = await waiting(
      [
        webhook(),
        waitForm({ responseMode: 'responseNode' }),
        node(
          'Reply',
          'core.respondToWebhook',
          { respondWith: 'json', responseBody: '={{ { "you said": $json.Ok } }}' },
          [400, 0],
        ),
      ],
      ['Hook', 'Wait', 'Reply'],
    );
    const res = await post(url, { 'field-0': 'yes' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ 'you said': 'yes' });
    await waitForExecution(server.ctx, tenant.id, execution.id, ['success']);
  });

  it('Using Respond to Webhook Node without one: the n8n error, the run keeps waiting', async () => {
    const { tenant, execution, url } = await waiting(
      [webhook(), waitForm({ responseMode: 'responseNode' })],
      ['Hook', 'Wait'],
    );
    const shown = await get(url);
    expect(shown.body).toContain('No Respond to Webhook node found in the workflow');
    const res = await post(url, { 'field-0': 'yes' });
    expect(res.json().message).toBe('No Respond to Webhook node found in the workflow');
    expect((await server.ctx.repos.executions.get(tenant.id, execution.id))?.status).toBe('waiting');
  });

  it('a form page after it: the answer says where to go', async () => {
    const { url } = await waiting(
      [
        webhook(),
        waitForm(),
        node(
          'More',
          'core.wait',
          {
            resume: 'form',
            formTitle: 'More',
            formFields: { values: [{ fieldLabel: 'Why', fieldType: 'text' }] },
          },
          [400, 0],
        ),
      ],
      ['Hook', 'Wait', 'More'],
    );
    const res = await post(url, { 'field-0': 'yes' });
    expect(res.statusCode).toBe(200);
    expect(pathOf(res.json().formWaitingUrl)).toBe(url);
    await atFormPage(url);
    expect((await get(url)).body).toContain('Why');
  });

  it('after a Form Trigger it is a form page too', async () => {
    const { client, tenant } = await owner();
    await active(client, [trigger(), waitForm()], chain('Start', 'Wait'));
    const url = await submitTrigger(tenant.slug);
    expect((await get(url)).body).toContain('Approve');
  });

  it('a redirect from a Respond to Webhook node turns into an answer, and only http or https', async () => {
    const reply = (redirectURL: string) =>
      node('Reply', 'core.respondToWebhook', { respondWith: 'redirect', redirectURL }, [400, 0]);
    const good = await waiting(
      [webhook(), waitForm({ responseMode: 'responseNode' }), reply('https://example.com/x')],
      ['Hook', 'Wait', 'Reply'],
    );
    const answer = await post(good.url, { 'field-0': 'yes' });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ redirectURL: 'https://example.com/x' });

    const bad = await waiting(
      [webhook(), waitForm({ responseMode: 'responseNode' }), reply('javascript:alert(1)')],
      ['Hook', 'Wait', 'Reply'],
    );
    const refused = await post(bad.url, { 'field-0': 'yes' });
    expect(refused.statusCode).toBe(500);
    expect(refused.body).not.toContain('javascript:');
  });
});
