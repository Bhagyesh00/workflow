/** P4-29 RSS Feed Trigger: polls a feed over guarded ctx.http, items newer than the last item date. */

import { afterEach, describe, expect, it } from 'vitest';
import { nodes } from '../src';
import { contextFor } from './contexts';
import { localHttp, startHttpServer } from './servers';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const typeOf = () => nodes.find((n) => n.description.name === 'core.rssFeedReadTrigger')!;

const rss = (items: Array<{ title: string; date: string }>) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>http://x</link><description>d</description>${items
    .map((i) => `<item><title>${i.title}</title><link>http://x/${i.title}</link><pubDate>${i.date}</pubDate></item>`)
    .join('')}</channel></rss>`;

async function feedServer(initial: string) {
  const state = { body: initial };
  const server = await startHttpServer((_req, res) => {
    res.setHeader('content-type', 'application/rss+xml');
    res.end(state.body);
  });
  closers.push(server.close);
  return { state, url: server.url };
}

const OLD = { title: 'old', date: 'Mon, 01 Jan 2024 10:00:00 GMT' };
const NEW = { title: 'new', date: 'Tue, 02 Jan 2024 10:00:00 GMT' };

function polling(url: string, staticData: Record<string, unknown>, mode: 'manual' | 'trigger' = 'trigger') {
  const c = contextFor('core.rssFeedReadTrigger', { feedUrl: url }, {
    services: { http: localHttp() },
    staticData,
  });
  return { ctx: c.poll(mode), c };
}

describe('RSS Feed Trigger', () => {
  it('has the polling flag and a Feed URL parameter', () => {
    expect(typeOf().description.polling).toBe(true);
    expect(typeOf().description.properties.map((p) => p.name)).toContain('feedUrl');
  });

  it('starts one run for a new item and none for the old item', async () => {
    const feed = await feedServer(rss([OLD]));
    const data: Record<string, unknown> = {};
    const first = polling(feed.url, data);
    expect(await typeOf().poll!(first.ctx)).toBeNull();
    const again = polling(feed.url, data);
    expect(await typeOf().poll!(again.ctx)).toBeNull();
    feed.state.body = rss([NEW, OLD]);
    const third = polling(feed.url, data);
    const out = await typeOf().poll!(third.ctx);
    expect(out?.[0]).toHaveLength(1);
    expect(out?.[0][0].json.title).toBe('new');
    const fourth = polling(feed.url, data);
    expect(await typeOf().poll!(fourth.ctx)).toBeNull();
  });

  it('manual mode returns the newest item', async () => {
    const feed = await feedServer(rss([OLD, NEW]));
    const { ctx } = polling(feed.url, {}, 'manual');
    const out = await typeOf().poll!(ctx);
    expect(out?.[0]).toHaveLength(1);
    expect(out?.[0][0].json.title).toBe('new');
  });

  it('fails with n8n texts on an empty URL and an unreadable feed', async () => {
    await expect(typeOf().poll!(polling('', {}).ctx)).rejects.toThrow('The parameter "URL" has to be set!');
    const feed = await feedServer('not xml at all <<<');
    await expect(typeOf().poll!(polling(feed.url, {}).ctx)).rejects.toThrow(/feed/i);
  });

  it('is refused by the SSRF guard without an allow-list', async () => {
    const feed = await feedServer(rss([OLD]));
    const c = contextFor('core.rssFeedReadTrigger', { feedUrl: feed.url });
    await expect(typeOf().poll!(c.poll('manual'))).rejects.toThrow();
  });
});
