import type { DataObject, Item } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { telegramSecretToken } from '../src/nodes/apps/Telegram.node';
import { contextFor } from './contexts';
import { FakeHttpClient, runNode } from './harness';

const TOKEN = '123456:SECRET-bot-token';
const creds = { telegramApi: { accessToken: TOKEN, baseUrl: 'https://api.telegram.org' } };
const items = (...list: object[]): Item[] => list.map((json) => ({ json: json as DataObject }));
const API = `https://api.telegram.org/bot${TOKEN}`;

function telegram(handler: (method: string, body: DataObject) => unknown) {
  return new FakeHttpClient().on('POST', API, (req) =>
    handler(req.url.slice(API.length + 1), (req.body as DataObject) ?? {}),
  );
}

describe('Telegram', () => {
  it('sends text messages with parse mode, keyboard and reply', async () => {
    const http = telegram(() => ({ ok: true, result: { message_id: 5, chat: { id: 42 }, text: 'Hi Ada' } }));
    const r = await runNode(
      'app.telegram',
      {
        chatId: '42',
        text: '=Hi {{ $json.name }}',
        additionalFields: {
          parse_mode: 'HTML',
          reply_to_message_id: 3,
          reply_markup: '{"inline_keyboard":[[{"text":"OK","callback_data":"ok"}]]}',
        },
      },
      items({ name: 'Ada' }),
      { creds, services: { http } },
    );
    expect(r.outputs[0]).toEqual([{ message_id: 5, chat: { id: 42 }, text: 'Hi Ada' }]);
    expect(http.requests[0]).toMatchObject({ method: 'POST', url: `${API}/sendMessage`, bodyType: 'json' });
    expect(http.requests[0].body).toEqual({
      chat_id: '42',
      text: 'Hi Ada',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: 'OK', callback_data: 'ok' }]] },
      reply_parameters: { message_id: 3 },
    });
  });

  it('uploads photos as multipart and sends documents by URL', async () => {
    const http = telegram(() => ({ ok: true, result: { message_id: 6 } }));
    await runNode(
      'app.telegram',
      { operation: 'sendPhoto', chatId: '42', binaryData: true, additionalFields: { caption: 'Look' } },
      [
        {
          json: {},
          binary: {
            data: { data: Buffer.from('JPEG').toString('base64'), mimeType: 'image/jpeg', fileName: 'p.jpg' },
          },
        },
      ],
      { creds, services: { http } },
    );
    const upload = http.requests[0];
    expect(upload.bodyType).toBe('multipart');
    expect(upload.body).toMatchObject({
      chat_id: '42',
      caption: 'Look',
      photo: { fileName: 'p.jpg', mimeType: 'image/jpeg' },
    });
    expect(Buffer.from((upload.body as { photo: { data: Uint8Array } }).photo.data).toString()).toBe('JPEG');
    await runNode(
      'app.telegram',
      { operation: 'sendDocument', chatId: '42', file: 'https://example.com/a.pdf' },
      items({}),
      { creds, services: { http } },
    );
    expect(http.requests[1].body).toEqual({ chat_id: '42', document: 'https://example.com/a.pdf' });
  });

  it('sends locations and chat actions, edits, deletes and pins messages', async () => {
    const http = telegram((method) => ({
      ok: true,
      result: method === 'editMessageText' ? { message_id: 5, text: 'new' } : true,
    }));
    const call = (params: DataObject) =>
      runNode('app.telegram', { chatId: '42', ...params }, items({}), { creds, services: { http } });
    expect((await call({ operation: 'sendLocation', latitude: 52.52, longitude: 13.4 })).status).toBe(
      'success',
    );
    expect(http.requests.at(-1)!.body).toMatchObject({ latitude: 52.52, longitude: 13.4 });
    expect((await call({ operation: 'sendChatAction', action: 'upload_photo' })).outputs[0]).toEqual([
      { success: true },
    ]);
    expect((await call({ operation: 'editMessageText', messageId: '5', text: 'new' })).outputs[0]).toEqual([
      { message_id: 5, text: 'new' },
    ]);
    expect((await call({ operation: 'deleteMessage', messageId: '5' })).outputs[0]).toEqual([
      { success: true },
    ]);
    expect(
      (
        await call({
          operation: 'pinChatMessage',
          messageId: '5',
          additionalFields: { disable_notification: true },
        })
      ).outputs[0],
    ).toEqual([{ success: true }]);
    expect(http.requests.at(-1)!.body).toEqual({ chat_id: '42', message_id: 5, disable_notification: true });
    const bad = await call({ operation: 'sendLocation', latitude: 100, longitude: 0 });
    expect(bad.error?.message).toMatch(/Latitude/);
  });

  it('reads chats and administrators and answers callback queries', async () => {
    const http = telegram((method) => {
      if (method === 'getChat') return { ok: true, result: { id: 42, title: 'Team' } };
      if (method === 'getChatAdministrators')
        return { ok: true, result: [{ user: { id: 1 } }, { user: { id: 2 } }] };
      return { ok: true, result: true };
    });
    const call = (params: DataObject) =>
      runNode('app.telegram', params, items({}), { creds, services: { http } });
    expect((await call({ resource: 'chat', operation: 'get', chatId: '42' })).outputs[0]).toEqual([
      { id: 42, title: 'Team' },
    ]);
    expect(
      (await call({ resource: 'chat', operation: 'administrators', chatId: '42' })).outputs[0],
    ).toHaveLength(2);
    const answered = await call({
      resource: 'callback',
      operation: 'answerQuery',
      queryId: 'q1',
      additionalFields: { text: 'Done', show_alert: true },
    });
    expect(answered.outputs[0]).toEqual([{ success: true }]);
    expect(http.requests.at(-1)!.body).toEqual({ callback_query_id: 'q1', text: 'Done', show_alert: true });
  });

  it('never leaks the bot token in errors', async () => {
    const http = telegram(() => ({
      __status: 400,
      body: { ok: false, error_code: 400, description: `Bad Request: chat not found (${TOKEN})` },
    }));
    const r = await runNode('app.telegram', { chatId: '0', text: 'x' }, items({}), {
      creds,
      services: { http },
    });
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('Bad Request: chat not found ([redacted])');
    expect(JSON.stringify(r.result.state)).not.toContain('SECRET-bot-token');
    expect(r.error?.request?.url).toBe('https://api.telegram.org/bot[redacted]/sendMessage');
  });
});

describe('Telegram Trigger', () => {
  const webhookUrl = 'https://hooks.example.com/webhook/acme/abc/webhook';
  const expectedSecret = telegramSecretToken(TOKEN, 't1', 'wf1', 'tg-node');
  const setup = (parameters: DataObject, http = new FakeHttpClient()) =>
    contextFor('app.telegramTrigger', parameters, {
      creds,
      services: { http },
      node: { webhookId: 'tg-node' },
    });

  it('registers, checks and deletes its webhook with a secret token', async () => {
    let registered = '';
    const http = telegram((method, body) => {
      if (method === 'setWebhook') {
        registered = String(body.url);
        return { ok: true, result: true };
      }
      if (method === 'getWebhookInfo') return { ok: true, result: { url: registered } };
      if (method === 'deleteWebhook') return { ok: true, result: true };
      return { ok: false };
    });
    const ctx = setup({ updates: ['message', 'callback_query'] }, http);
    const methods = ctx.nodeType.webhookMethods!.default;
    expect(await methods.checkExists(ctx.lifecycle(webhookUrl))).toBe(false);
    expect(await methods.create(ctx.lifecycle(webhookUrl))).toBe(true);
    expect(http.requests[1].body).toEqual({
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query'],
      secret_token: expectedSecret,
    });
    expect(expectedSecret).toMatch(/^[A-Za-z0-9_-]{1,256}$/);
    expect(await methods.checkExists(ctx.lifecycle(webhookUrl))).toBe(true);
    expect(await methods.delete(ctx.lifecycle(webhookUrl))).toBe(true);
  });

  it('accepts updates only with the right secret token', async () => {
    const ctx = setup({ updates: ['message'] });
    const update = { update_id: 1, message: { message_id: 9, chat: { id: 42 }, text: '/start' } };
    const ok = await ctx.nodeType.webhook!(
      ctx.webhook({ headers: { 'x-telegram-bot-api-secret-token': expectedSecret }, body: update }),
    );
    expect(ok.workflowData?.[0][0].json).toEqual(update);
    const forged = await ctx.nodeType.webhook!(
      ctx.webhook({ headers: { 'x-telegram-bot-api-secret-token': 'guess' }, body: update }),
    );
    expect(forged).toEqual({
      webhookResponse: { statusCode: 403, body: { message: 'Invalid secret token' } },
    });
    const missing = await ctx.nodeType.webhook!(ctx.webhook({ body: update }));
    expect(missing.workflowData).toBeUndefined();
  });

  it('ignores other update types and chats, and downloads files when asked', async () => {
    const http = new FakeHttpClient()
      .on('POST', `${API}/getFile`, () => ({ ok: true, result: { file_path: 'documents/file_1.pdf' } }))
      .on('GET', `https://api.telegram.org/file/bot${TOKEN}/documents/file_1.pdf`, () => Buffer.from('%PDF'));
    const ctx = setup({ updates: ['message'], additionalFields: { download: true, chatIds: '42' } }, http);
    const headers = { 'x-telegram-bot-api-secret-token': expectedSecret };
    const callback = await ctx.nodeType.webhook!(
      ctx.webhook({ headers, body: { update_id: 2, callback_query: { id: 'q' } } }),
    );
    expect(callback).toEqual({ webhookResponse: { statusCode: 200, body: { ok: true } } });
    const otherChat = await ctx.nodeType.webhook!(
      ctx.webhook({ headers, body: { update_id: 3, message: { chat: { id: 7 }, text: 'hi' } } }),
    );
    expect(otherChat.workflowData).toBeUndefined();
    const withFile = await ctx.nodeType.webhook!(
      ctx.webhook({
        headers,
        body: {
          update_id: 4,
          message: {
            chat: { id: 42 },
            document: { file_id: 'F1', file_name: 'a.pdf', mime_type: 'application/pdf' },
          },
        },
      }),
    );
    expect(withFile.workflowData?.[0][0].binary?.data).toMatchObject({
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
    });
  });
});
