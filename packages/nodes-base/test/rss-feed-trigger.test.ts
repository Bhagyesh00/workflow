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
    .map(
      (i) =>
        `<item><title>${i.title}</title><link>http://x/${i.title}</link><pubDate>${i.date}</pubDate></item>`,
    )
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

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toUTCString();
/** the poll's own scope in the static data, as the harness keeps it */
const scope = (data: Record<string, unknown>) => (data['node:Node'] ?? {}) as { lastTimeChecked?: string };

const OLD = { title: 'old', date: hoursAgo(48) };
const NEW = { title: 'new', date: hoursAgo(-1) };

function polling(url: string, staticData: Record<string, unknown>, mode: 'manual' | 'trigger' = 'trigger') {
  const c = contextFor(
    'core.rssFeedReadTrigger',
    { feedUrl: url },
    {
      services: { http: localHttp() },
      staticData,
    },
  );
  return { ctx: c.poll(mode), c };
}

describe('RSS Feed Trigger', () => {
  it('has the polling flag, a Feed URL and a Poll Times parameter', () => {
    expect(typeOf().description.polling).toBe(true);
    expect(typeOf().description.properties.map((p) => p.name)).toEqual(['feedUrl', 'pollTimes']);
  });

  it('Poll Times is a repeatable item with the modes the server reads, default every minute', () => {
    const prop = typeOf().description.properties.find((p) => p.name === 'pollTimes')!;
    expect(prop.type).toBe('fixedCollection');
    expect(prop.typeOptions).toMatchObject({ multipleValues: true });
    expect(prop.default).toEqual({ item: [{ mode: 'everyMinute' }] });
    const group = (
      prop.options as Array<{
        name: string;
        values: Array<{ name: string; options?: Array<{ value: string }> }>;
      }>
    )[0]!;
    expect(group.name).toBe('item');
    const modes = group.values.find((v) => v.name === 'mode')!.options!.map((o) => o.value);
    expect(modes).toEqual([
      'everyMinute',
      'everyHour',
      'everyDay',
      'everyWeek',
      'everyMonth',
      'everyX',
      'custom',
    ]);
    expect(group.values.map((v) => v.name)).toEqual(
      expect.arrayContaining(['hour', 'minute', 'weekday', 'dayOfMonth', 'value', 'unit', 'cronExpression']),
    );
  });

  it('starts one run for an item newer than the last check and none for the old item', async () => {
    const feed = await feedServer(rss([OLD]));
    const data: Record<string, unknown> = {};
    // no stored time: the cutoff is now, so the old item does not start a run
    expect(await typeOf().poll!(polling(feed.url, data).ctx)).toBeNull();
    expect(typeof scope(data).lastTimeChecked).toBe('string');
    expect(await typeOf().poll!(polling(feed.url, data).ctx)).toBeNull();
    // an item published after the last check
    scope(data).lastTimeChecked = new Date(Date.now() - 2 * 3_600_000).toISOString();
    feed.state.body = rss([NEW, OLD]);
    const out = await typeOf().poll!(polling(feed.url, data).ctx);
    expect(out?.[0]).toHaveLength(1);
    expect(out?.[0][0].json.title).toBe('new');
  });

  it('with no stored state the cutoff is now: an item dated just before the poll does not run', async () => {
    const feed = await feedServer(rss([{ title: 'recent', date: hoursAgo(1) }]));
    const data: Record<string, unknown> = {};
    expect(await typeOf().poll!(polling(feed.url, data).ctx)).toBeNull();
    const stored = Date.parse(String(scope(data).lastTimeChecked));
    expect(Math.abs(Date.now() - stored)).toBeLessThan(5000);
  });

  it('manual mode returns the first item of the feed and writes no state', async () => {
    const feed = await feedServer(rss([OLD, NEW]));
    const data: Record<string, unknown> = {};
    const { ctx } = polling(feed.url, data, 'manual');
    const out = await typeOf().poll!(ctx);
    expect(out?.[0]).toHaveLength(1);
    expect(out?.[0][0].json.title).toBe('old');
    expect(scope(data).lastTimeChecked).toBeUndefined();
    const empty = await feedServer(rss([]));
    expect(await typeOf().poll!(polling(empty.url, {}, 'manual').ctx)).toBeNull();
  });

  it('a closed port gives a text that says to check the URL, without the raw client error', async () => {
    const probe = await startHttpServer((_req, res) => res.end());
    const url = `http://127.0.0.1:${new URL(probe.url).port}/secret-path`;
    await probe.close();
    const error = await typeOf().poll!(polling(url, {}, 'manual').ctx).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toMatch(/Couldn't connect to the feed URL/);
    expect(error?.message).toContain('Check that the URL is correct');
    expect(error?.message).not.toContain('secret-path');
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
