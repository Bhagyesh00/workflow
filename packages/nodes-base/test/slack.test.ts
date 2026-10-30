import type { DataObject, Item } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { contextFor } from './contexts';
import { FakeHttpClient, runNode } from './harness';

const creds = { slackApi: { accessToken: 'xoxb-test' } };
const items = (...list: object[]): Item[] => list.map((json) => ({ json: json as DataObject }));
const channel = { __rl: true, mode: 'id', value: 'C123' };

function slack(handler: (method: string, body: DataObject, qs: Record<string, string>) => unknown) {
  return new FakeHttpClient().on('*', /^https:\/\/slack\.com\/api\//, (req) => {
    const url = new URL(req.url);
    return handler(
      url.pathname.replace('/api/', ''),
      (req.body as DataObject) ?? {},
      Object.fromEntries(url.searchParams),
    );
  });
}

describe('Slack', () => {
  it('sends a message with bearer auth and JSON body', async () => {
    const http = slack(() => ({ ok: true, channel: 'C123', ts: '1.2', message: { text: 'hi' } }));
    const r = await runNode(
      'app.slack',
      {
        resource: 'message',
        operation: 'send',
        channelId: channel,
        text: '=Order {{ $json.id }} shipped',
        otherOptions: { thread_ts: '9.9' },
      },
      items({ id: 42 }),
      { creds, services: { http } },
    );
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([{ ok: true, channel: 'C123', ts: '1.2', message: { text: 'hi' } }]);
    const [req] = http.requests;
    expect(req).toMatchObject({ method: 'POST', url: 'https://slack.com/api/chat.postMessage' });
    expect(req.headers.authorization).toBe('Bearer xoxb-test');
    expect(req.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(req.body).toEqual({ channel: 'C123', text: 'Order 42 shipped', thread_ts: '9.9' });
  });

  it('sends blocks and direct messages, extracting channel ids from URLs', async () => {
    const http = slack(() => ({ ok: true }));
    await runNode(
      'app.slack',
      {
        resource: 'message',
        operation: 'send',
        select: 'user',
        user: { __rl: true, mode: 'id', value: 'U9' },
        messageType: 'block',
        text: 'fallback',
        blocksUi: '{"blocks":[{"type":"section","text":{"type":"mrkdwn","text":"*hi*"}}]}',
      },
      items({}),
      { creds, services: { http } },
    );
    expect(http.requests[0].body).toEqual({
      channel: 'U9',
      text: 'fallback',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*hi*' } }],
    });
    await runNode(
      'app.slack',
      {
        resource: 'message',
        operation: 'delete',
        channelId: { __rl: true, mode: 'url', value: 'https://acme.slack.com/archives/C777' },
        ts: '1.1',
      },
      items({}),
      { creds, services: { http } },
    );
    expect(http.requests[1]).toMatchObject({
      url: 'https://slack.com/api/chat.delete',
      body: { channel: 'C777', ts: '1.1' },
    });
  });

  it('turns ok:false into a helpful error and continues on fail', async () => {
    const http = slack(() => ({ ok: false, error: 'not_in_channel' }));
    const r = await runNode(
      'app.slack',
      { resource: 'message', operation: 'send', channelId: channel, text: 'x' },
      items({}),
      { creds, services: { http } },
    );
    expect(r.status).toBe('error');
    expect(r.error).toMatchObject({
      message: expect.stringMatching(/not a member of this channel/),
      code: 'SLACK_NOT_IN_CHANNEL',
    });
    const c = await runNode(
      'app.slack',
      { resource: 'message', operation: 'send', channelId: channel, text: 'x' },
      items({}, {}),
      {
        creds,
        services: { http },
        node: { onError: 'continueRegularOutput' },
      },
    );
    expect(c.outputs[0]).toHaveLength(2);
    expect(c.outputs[0][0].error).toMatch(/not a member/);
  });

  it('paginates channel lists and history with cursors', async () => {
    const http = slack((method, _body, qs) => {
      if (method === 'conversations.list') {
        return qs.cursor
          ? { ok: true, channels: [{ id: 'C3' }], response_metadata: { next_cursor: '' } }
          : { ok: true, channels: [{ id: 'C1' }, { id: 'C2' }], response_metadata: { next_cursor: 'next' } };
      }
      return { ok: true, messages: [{ ts: '1' }, { ts: '2' }] };
    });
    const all = await runNode(
      'app.slack',
      { resource: 'channel', operation: 'list', returnAll: true },
      items({}),
      { creds, services: { http } },
    );
    expect(all.outputs[0]).toEqual([{ id: 'C1' }, { id: 'C2' }, { id: 'C3' }]);
    expect(http.requests[0].url).toContain('types=public_channel');
    const history = await runNode(
      'app.slack',
      {
        resource: 'channel',
        operation: 'history',
        channelId: channel,
        limit: 1,
        filters: { oldest: '2024-01-01T00:00:00Z' },
      },
      items({}),
      { creds, services: { http } },
    );
    expect(history.outputs[0]).toEqual([{ ts: '1' }]);
    expect(new URL(http.requests.at(-1)!.url).searchParams.get('oldest')).toBe('1704067200');
  });

  it('creates channels, invites users, reads users and permalinks, searches and reacts', async () => {
    const http = slack((method) => {
      switch (method) {
        case 'conversations.create':
        case 'conversations.invite':
        case 'conversations.info':
          return { ok: true, channel: { id: 'C9', name: 'x' } };
        case 'users.info':
          return { ok: true, user: { id: 'U1', name: 'ada' } };
        case 'users.list':
          return { ok: true, members: [{ id: 'U1' }, { id: 'U2' }] };
        case 'chat.getPermalink':
          return { ok: true, permalink: 'https://acme.slack.com/p1' };
        case 'search.messages':
          return { ok: true, messages: { matches: [{ text: 'invoice' }], paging: { pages: 1 } } };
        default:
          return { ok: true };
      }
    });
    const call = (params: DataObject) =>
      runNode('app.slack', params, items({}), { creds, services: { http } });
    expect(
      (await call({ resource: 'channel', operation: 'create', channelName: '#Project-X', isPrivate: true }))
        .outputs[0],
    ).toEqual([{ id: 'C9', name: 'x' }]);
    expect(http.requests.at(-1)!.body).toEqual({ name: 'Project-X', is_private: true });
    await call({ resource: 'channel', operation: 'invite', channelId: channel, userIds: 'U1, U2' });
    expect(http.requests.at(-1)!.body).toEqual({ channel: 'C123', users: 'U1,U2' });
    expect((await call({ resource: 'channel', operation: 'get', channelId: channel })).outputs[0]).toEqual([
      { id: 'C9', name: 'x' },
    ]);
    expect(
      (await call({ resource: 'user', operation: 'info', user: { __rl: true, mode: 'id', value: 'U1' } }))
        .outputs[0],
    ).toEqual([{ id: 'U1', name: 'ada' }]);
    expect((await call({ resource: 'user', operation: 'getAll', returnAll: true })).outputs[0]).toHaveLength(
      2,
    );
    expect(
      (await call({ resource: 'message', operation: 'getPermalink', channelId: channel, ts: '1.0' }))
        .outputs[0][0].permalink,
    ).toBe('https://acme.slack.com/p1');
    expect(
      (await call({ resource: 'message', operation: 'search', query: 'invoice', returnAll: true }))
        .outputs[0],
    ).toEqual([{ text: 'invoice' }]);
    await call({ resource: 'reaction', operation: 'add', channelId: channel, ts: '1.0', name: ':thumbsup:' });
    expect(http.requests.at(-1)).toMatchObject({
      url: 'https://slack.com/api/reactions.add',
      body: { channel: 'C123', timestamp: '1.0', name: 'thumbsup' },
    });
    await call({ resource: 'reaction', operation: 'remove', channelId: channel, ts: '1.0', name: 'eyes' });
    expect(http.requests.at(-1)!.url).toBe('https://slack.com/api/reactions.remove');
  });

  it('uploads files with the external upload flow', async () => {
    const http = new FakeHttpClient()
      .on('GET', 'https://slack.com/api/files.getUploadURLExternal', () => ({
        ok: true,
        upload_url: 'https://files.slack.com/upload/v1/abc',
        file_id: 'F1',
      }))
      .on('POST', 'https://files.slack.com/upload/', () => 'OK - 5')
      .on('POST', 'https://slack.com/api/files.completeUploadExternal', () => ({
        ok: true,
        files: [{ id: 'F1', title: 'report.txt' }],
      }));
    const r = await runNode(
      'app.slack',
      { resource: 'file', operation: 'upload', channelId: channel, options: { initialComment: 'Here' } },
      [
        {
          json: {},
          binary: {
            data: {
              data: Buffer.from('hello').toString('base64'),
              mimeType: 'text/plain',
              fileName: 'report.txt',
            },
          },
        },
      ],
      { creds, services: { http } },
    );
    expect(r.outputs[0]).toEqual([{ id: 'F1', title: 'report.txt' }]);
    expect(new URL(http.requests[0].url).searchParams.get('length')).toBe('5');
    expect(Buffer.from(http.requests[1].body as Uint8Array).toString()).toBe('hello');
    expect(http.requests[1].headers.authorization).toBeUndefined();
    expect(http.requests[2].body).toEqual({
      files: [{ id: 'F1', title: 'report.txt' }],
      channel_id: 'C123',
      initial_comment: 'Here',
    });
  });

  it('uses the OAuth2 credential when selected', async () => {
    const http = slack(() => ({ ok: true }));
    await runNode(
      'app.slack',
      { authentication: 'oAuth2', resource: 'channel', operation: 'get', channelId: channel },
      items({}),
      {
        creds: { slackOAuth2Api: { oauthTokenData: { access_token: 'xoxp-oauth' } } },
        services: { http },
      },
    );
    expect(http.requests[0].headers.authorization).toBe('Bearer xoxp-oauth');
  });

  it('searches channels and users for the resource locator', async () => {
    const http = slack((method) =>
      method === 'conversations.list'
        ? {
            ok: true,
            channels: [
              { id: 'C1', name: 'general' },
              { id: 'C2', name: 'random' },
            ],
            response_metadata: { next_cursor: 'n2' },
          }
        : {
            ok: true,
            members: [
              { id: 'U1', name: 'ada', real_name: 'Ada L' },
              { id: 'U2', name: 'gone', deleted: true },
            ],
          },
    );
    const ctx = contextFor('app.slack', {}, { creds, services: { http } });
    const channels = await ctx.nodeType.methods!.listSearch!.searchChannels(ctx.loadOptions(), 'gen');
    expect(channels).toEqual({ results: [{ name: '#general', value: 'C1' }], paginationToken: 'n2' });
    const users = await ctx.nodeType.methods!.listSearch!.searchUsers(ctx.loadOptions());
    expect(users.results).toEqual([{ name: 'Ada L', value: 'U1' }]);
  });
});
