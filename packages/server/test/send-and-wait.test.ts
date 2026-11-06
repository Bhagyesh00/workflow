/** P4-17: an approval link and a custom form each resume the run that waits on Send and Wait for Response. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DataObject } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  outputOf,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  waitFor,
  waitForExecution,
} from './helpers';

const TOKEN = '777:bot-secret-token';

let server: TestServer;
let telegram: Server;
let baseUrl = '';
/** the sendMessage calls the fake Telegram took */
let sent: DataObject[] = [];

beforeAll(async () => {
  server = await createTestServer();
  telegram = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url?.endsWith('/sendMessage')) sent.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
    });
  });
  await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(telegram.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await server.close();
  await new Promise((resolve) => telegram.close(resolve));
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  sent = [];
});

let signups = 0;
const owner = () =>
  signup(server.app, { remoteAddress: `10.9.${Math.floor(++signups / 200)}.${signups % 200}` });

function multipart(fields: Record<string, string | string[]>) {
  const boundary = 'SENDWAITB0UNDARY';
  const lines: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      lines.push(`--${boundary}`, `Content-Disposition: form-data; name="${name}"`, '', one);
    }
  }
  lines.push(`--${boundary}--`, '');
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: lines.join('\r\n'),
  };
}

/** a workflow that sends through the fake Telegram and waits, then sets `after` */
async function waitingRun(parameters: DataObject) {
  const session = await owner();
  const { client, tenant } = session;
  const credential = await client.data(
    client.post('/rest/credentials', {
      name: 'Bot',
      type: 'telegramApi',
      data: { accessToken: TOKEN, baseUrl },
    }),
  );
  const wf = await createWorkflow(client, {
    nodes: [
      node('Start', 'core.manualTrigger'),
      node(
        'Ask',
        'app.telegram',
        { resource: 'message', operation: 'sendAndWait', chatId: '42', ...parameters },
        [200, 0],
        { credentials: { telegramApi: { id: credential.id, name: 'Bot' } } },
      ),
      setNode('After', 'after', 'yes', [400, 0]),
    ],
    connections: chain('Start', 'Ask', 'After'),
  });
  const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
  await waitForExecution(server.ctx, tenant.id, executionId, ['waiting']);
  const keyboard = (sent[0].reply_markup as { inline_keyboard: Array<Array<{ text: string; url: string }>> })
    .inline_keyboard[0];
  const links = Object.fromEntries(
    keyboard.map((b) => [b.text, new URL(b.url).pathname + new URL(b.url).search]),
  );
  const status = async () => (await server.ctx.repos.executions.get(tenant.id, executionId))?.status;
  const finished = async () => {
    await waitForExecution(server.ctx, tenant.id, executionId, ['success']);
    const after = await client.data(client.get(`/rest/executions/${executionId}`));
    return {
      asked: outputOf(after.state, 'Ask')[0],
      after: outputOf(after.state, 'After')[0],
    };
  };
  return { executionId, links, status, finished };
}

const get = (url: string, headers: Record<string, string> = {}) =>
  server.app.inject({ method: 'GET', url, headers });

describe('approval links', () => {
  it('the Approve link resumes the run with approved true', async () => {
    const run = await waitingRun({ message: 'Ship the order?' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chat_id: '42', text: 'Ship the order?' });
    expect(Object.keys(run.links)).toEqual(['Approve']);
    expect(run.links.Approve).toMatch(
      new RegExp(`^/webhook-waiting/${run.executionId}/[A-Za-z0-9_-]+/[\\w-]+/answer\\?approved=true$`),
    );

    const res = await get(run.links.Approve);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.body).toContain('Your response has been recorded');
    const { asked, after } = await run.finished();
    expect(asked).toEqual({ data: { approved: true } });
    expect(after).toMatchObject({ after: 'yes' });
  });

  it('the Decline link of an approve and decline message resumes with approved false', async () => {
    const run = await waitingRun({
      message: 'Ship it?',
      approvalOptions: { values: { approvalType: 'double', approveLabel: 'Yes', disapproveLabel: 'No' } },
    });
    expect(Object.keys(run.links)).toEqual(['Yes', 'No']);
    expect((await get(run.links.No)).statusCode).toBe(200);
    expect((await run.finished()).asked).toEqual({ data: { approved: false } });
  });

  it('a link answers once', async () => {
    const run = await waitingRun({ message: 'Ship it?' });
    expect((await get(run.links.Approve)).statusCode).toBe(200);
    await run.finished();
    const again = await get(run.links.Approve);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('not_waiting');
  });

  it('a browser on a link that was answered gets a page', async () => {
    const run = await waitingRun({ message: 'Ship it?' });
    const browser = { accept: 'text/html,application/xhtml+xml' };
    expect((await get(run.links.Approve, browser)).statusCode).toBe(200);
    await run.finished();
    const again = await get(run.links.Approve, browser);
    expect(again.statusCode).toBe(409);
    expect(again.headers['content-type']).toContain('text/html');
    expect(again.headers['content-security-policy']).toContain('sandbox');
    expect(again.body).toContain('already answered');
  });

  it('the URL a form submitter holds does not answer an approval (scenario A)', async () => {
    const run = await waitingRun({ message: 'Ship it?' });
    const form = new URL(server.ctx.executions.resumeFormUrl(run.executionId)).pathname;
    const signature = form.split('/').at(-1);
    const nodePart = new URL(run.links.Approve, 'http://x').pathname.split('/').slice(-2).join('/');
    const hook = `/webhook-waiting/${run.executionId}/${signature}`;
    expect((await get(`${hook}?approved=true`)).statusCode).toBe(404);
    expect((await get(`${hook}/${nodePart}?approved=true`)).statusCode).toBe(404);
    expect((await get(`${form}?approved=true`)).statusCode).toBe(404);
    expect((await get(`${form}/${nodePart}?approved=true`)).statusCode).toBe(404);
    expect(await run.status()).toBe('waiting');
    expect((await get(run.links.Approve)).statusCode).toBe(200);
    await run.finished();
  });

  it('a link answers only its own node, not the next gate of the run (scenario B)', async () => {
    const { client, tenant } = await owner();
    const credential = await client.data(
      client.post('/rest/credentials', {
        name: 'Bot',
        type: 'telegramApi',
        data: { accessToken: TOKEN, baseUrl },
      }),
    );
    const gate = (name: string, position: [number, number]) =>
      node(
        name,
        'app.telegram',
        { resource: 'message', operation: 'sendAndWait', chatId: '42', message: name },
        position,
        { credentials: { telegramApi: { id: credential.id, name: 'Bot' } } },
      );
    const wf = await createWorkflow(client, {
      nodes: [node('Start', 'core.manualTrigger'), gate('Employee', [200, 0]), gate('Manager', [400, 0])],
      connections: chain('Start', 'Employee', 'Manager'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId, ['waiting']);
    const linkOf = (index: number) => {
      const markup = sent[index].reply_markup as { inline_keyboard: Array<Array<{ url: string }>> };
      const url = new URL(markup.inline_keyboard[0][0].url);
      return url.pathname + url.search;
    };
    const status = async () => (await server.ctx.repos.executions.get(tenant.id, executionId))?.status;
    const employee = linkOf(0);
    expect((await get(employee)).statusCode).toBe(200);
    await waitFor(async () => sent.length === 2 && (await status()) === 'waiting');

    const again = await get(employee);
    expect(again.statusCode).toBe(404);
    const page = await get(employee, { accept: 'text/html' });
    expect(page.statusCode).toBe(409);
    expect(page.body).toContain('already answered');
    // the signed URL alone opens no gate either
    expect((await get(`${employee.split('/').slice(0, 4).join('/')}?approved=true`)).statusCode).toBe(404);
    expect(await status()).toBe('waiting');

    const manager = linkOf(1);
    expect(manager).not.toBe(employee);
    expect((await get(manager)).statusCode).toBe(200);
    await waitForExecution(server.ctx, tenant.id, executionId, ['success']);
  });

  it('a link preview or mail scanner does not answer', async () => {
    const run = await waitingRun({ message: 'Ship it?' });
    for (const agent of [
      'Slackbot-LinkExpanding 1.0',
      'Mozilla/5.0 (compatible; Googlebot/2.1)',
      'facebookexternalhit/1.1',
      'WhatsApp/2.23.20.0',
      'curl/8.5.0',
      'python-requests/2.31',
      'Go-http-client/1.1',
      'Microsoft Office/16.0',
    ]) {
      const res = await get(run.links.Approve, { 'user-agent': agent });
      expect(res.statusCode).toBe(200);
    }
    expect(await run.status()).toBe('waiting');
    expect((await get(run.links.Approve, { 'user-agent': 'Mozilla/5.0 Firefox/130.0' })).statusCode).toBe(
      200,
    );
    await run.finished();
  });

  it('a link with a wrong or no signature, or no answer, resumes nothing', async () => {
    const run = await waitingRun({ message: 'Ship it?' });
    const base = `/webhook-waiting/${run.executionId}`;
    expect((await get(`${base}/forged?approved=true`)).statusCode).toBe(404);
    expect((await get(`${base}?approved=true`)).statusCode).toBe(404);
    const signed = run.links.Approve.split('?')[0];
    // the signature without the node opens nothing
    const bare = signed.split('/').slice(0, 4).join('/');
    expect((await get(`${bare}?approved=true`)).statusCode).toBe(404);
    expect((await get(signed)).statusCode).toBe(400);
    expect((await get(`${signed}?approved=maybe`)).statusCode).toBe(400);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `${signed}?approved=true`,
          payload: { approved: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(await run.status()).toBe('waiting');
  });

  it('puts neither the bot token nor an unescaped message in the page or the links', async () => {
    const run = await waitingRun({ message: '<img src=x onerror=alert(1)>', responseType: 'freeText' });
    const res = await get(run.links.Respond);
    expect(res.body).not.toContain(TOKEN);
    expect(res.body).not.toContain('<img');
    expect(res.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(JSON.stringify(run.links)).not.toContain(TOKEN);
  });
});

describe('free text', () => {
  it('the page takes a text and resumes the run with it', async () => {
    const run = await waitingRun({ message: 'Why?', responseType: 'freeText' });
    expect(Object.keys(run.links)).toEqual(['Respond']);
    const page = await get(run.links.Respond);
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain('sandbox');
    expect(page.headers['content-security-policy']).not.toContain('allow-same-origin');
    expect(page.headers['set-cookie']).toBeUndefined();
    expect(page.body).toContain('Why?');
    // showing the page resumes nothing
    expect(await run.status()).toBe('waiting');

    const form = multipart({ 'field-0': 'Because {{ 1 + 1 }}' });
    const answered = await server.app.inject({
      method: 'POST',
      url: run.links.Respond,
      payload: form.payload,
      headers: form.headers,
    });
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toEqual({ formSubmittedText: 'Your response has been recorded' });
    expect((await run.finished()).asked).toEqual({ data: { text: 'Because {{ 1 + 1 }}' } });
  });
});

describe('custom form', () => {
  const formFields = {
    values: [
      { fieldLabel: 'Name', fieldType: 'text', requiredField: true },
      {
        fieldLabel: 'Tools',
        fieldType: 'checkbox',
        fieldOptions: { values: [{ option: 'a' }, { option: 'b' }] },
      },
    ],
  };

  it('the page takes the elements and resumes the run with the answers', async () => {
    const run = await waitingRun({
      message: 'Details?',
      responseType: 'customForm',
      formFields,
      options: { messageButtonLabel: 'Open the form', responseFormTitle: 'Order details' },
    });
    expect(Object.keys(run.links)).toEqual(['Open the form']);
    const page = await get(run.links['Open the form']);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>Order details</title>');
    expect(page.body).toContain('Tools');

    const missing = multipart({ 'field-0': ' ' });
    const refused = await server.app.inject({
      method: 'POST',
      url: run.links['Open the form'],
      payload: missing.payload,
      headers: missing.headers,
    });
    expect(refused.statusCode).toBe(400);
    expect(await run.status()).toBe('waiting');

    const form = multipart({ 'field-0': 'Ann', 'field-1': ['a', 'b'] });
    const answered = await server.app.inject({
      method: 'POST',
      url: run.links['Open the form'],
      payload: form.payload,
      headers: form.headers,
    });
    expect(answered.statusCode).toBe(200);
    const { asked, after } = await run.finished();
    expect(asked).toEqual({ data: { Name: 'Ann', Tools: ['a', 'b'] } });
    expect(after).toMatchObject({ after: 'yes' });
  });
});

describe('limit wait time', () => {
  it('the run waits until the limit, not forever', async () => {
    const run = await waitingRun({
      message: 'Hurry',
      options: {
        limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: 2, resumeUnit: 'hours' } },
      },
    });
    const row = await server.ctx.repos.executions.get(
      (await server.ctx.repos.executions.findTenantOf(run.executionId))!,
      run.executionId,
    );
    const left = row!.waitTill!.getTime() - Date.now();
    expect(left).toBeGreaterThan(3_600_000);
    expect(left).toBeLessThanOrEqual(7_200_000);
  });
});
