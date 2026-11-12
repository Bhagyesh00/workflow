/**
 * P6-62 (S5 L6): the Sentry destination type. A fake Sentry (test/fakes/http-sink.ts, plain and TLS) on 127.0.0.1
 * receives the envelope; no database, no network beyond 127.0.0.1. Values are fixed fakes, never printed.
 */
import { randomUUID } from 'node:crypto';
import { HttpClient } from '@workflow/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '../src/services/events/stream';
import { createSentrySender, validateSentrySettings } from '../src/services/log-streaming/destinations/sentry';
import type { SenderDeps, StoredDestination } from '../src/services/log-streaming/types';
import { type HttpSink, loadTlsFixtures, startHttpSink } from './fakes/http-sink';

const KEY = 'fakepublickey0123456789abcdef012345';
let sink: HttpSink;
let tlsSink: HttpSink;
const fixtures = loadTlsFixtures();

beforeAll(async () => {
  sink = await startHttpSink();
  tlsSink = await startHttpSink({ tls: { key: fixtures.key, cert: fixtures.cert } });
});
afterAll(async () => {
  await sink.close();
  await tlsSink.close();
});
beforeEach(() => {
  sink.requests.length = 0;
  sink.respondWith(200);
  tlsSink.requests.length = 0;
});

const deps = (policy: 'loopback' | 'default' = 'loopback', environment?: string): SenderDeps =>
  ({
    http: new HttpClient({ ssrf: policy === 'default' ? {} : { allow: ['127.0.0.1'] } }),
    credentials: {},
    cipher: {},
    config: { version: '9.8.7', environment },
    logger: {},
  }) as unknown as SenderDeps;

const dsnOf = (base: string, path = '/42') => base.replace('://', `://${KEY}@`) + path;

function destination(dsn: string, sendPayload = true, label = 'My Sentry'): StoredDestination {
  return {
    id: randomUUID(),
    label,
    type: 'sentry',
    settings: { dsn, sendPayload, tracesSampleRate: 0.5 },
  } as unknown as StoredDestination;
}

const event = (eventName = 'n8n.workflow.success', extra: Partial<StreamEvent> = {}): StreamEvent => ({
  id: randomUUID(),
  ts: '2026-11-12T10:00:00.000Z',
  eventName,
  message: eventName,
  payload: { workflowId: 'w1' },
  tenantId: randomUUID(),
  ...extra,
});

function parse(body: Buffer) {
  const lines = body.toString('utf8').split('\n').filter(Boolean);
  return { header: JSON.parse(lines[0]), item: JSON.parse(lines[1]), payload: JSON.parse(lines[2]) };
}

describe('validateSentrySettings', () => {
  it('accepts a DSN with key, host, optional prefix and project id', () => {
    expect(validateSentrySettings({ dsn: `https://${KEY}@o1.example.com/42`, sendPayload: true })).toBeNull();
    expect(validateSentrySettings({ dsn: `https://${KEY}@host:9000/pre/fix/7`, sendPayload: false })).toBeNull();
  });
  it('refuses a bad DSN or rate', () => {
    for (const dsn of [
      '',
      'not a url',
      'ftp://k@host/1',
      'https://host/1',
      `https://${KEY}@host`,
      `https://${KEY}@host/abc`,
      `https://${KEY}@host/1?x=1`,
    ]) {
      expect(validateSentrySettings({ dsn, sendPayload: true }), dsn).toEqual(expect.any(String));
    }
    expect(validateSentrySettings(null)).toEqual(expect.any(String));
    expect(validateSentrySettings({ dsn: `https://${KEY}@h/1`, sendPayload: 'yes' })).toEqual(
      expect.any(String),
    );
    expect(validateSentrySettings({ dsn: `https://${KEY}@h/1`, sendPayload: true, tracesSampleRate: 2 })).toEqual(
      expect.any(String),
    );
  });
});

describe('sentry sender', () => {
  it('posts an envelope with the auth header and the event fields', async () => {
    const sender = createSentrySender(deps('loopback', 'staging'), destination(dsnOf(sink.url, '/pre/42')));
    await sender.send(event('n8n.workflow.failed', { message: 'boom' }), {});
    const [req] = await sink.waitForRequests(1);
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/pre/api/42/envelope/');
    expect(req.headers['x-sentry-auth']).toBe(
      `Sentry sentry_version=7, sentry_client=workflow-log-streaming/9.8.7, sentry_key=${KEY}`,
    );
    const { header, item, payload } = parse(req.body);
    expect(header.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(item.type).toBe('event');
    expect(payload.event_id).toBe(header.event_id);
    expect(payload.message).toBe('boom');
    expect(payload.level).toBe('log');
    expect(payload.release).toBe('9.8.7');
    expect(payload.environment).toBe('staging');
    expect(payload.tags).toEqual({ event: 'n8n.workflow.failed', logger: 'My Sentry', app: expect.any(String) });
    expect(payload.extra).toEqual({ workflowId: 'w1' });
    expect(JSON.stringify(req.body.toString())).not.toContain(KEY);
  });

  it('uses level error when the event name ends with error, and omits extras without sendPayload', async () => {
    const sender = createSentrySender(deps(), destination(dsnOf(sink.url), false));
    await sender.send(event('node.error'), {});
    const [req] = await sink.waitForRequests(1);
    const { payload } = parse(req.body);
    expect(payload.level).toBe('error');
    expect(payload.extra).toBeUndefined();
    expect(payload.environment).toBeUndefined();
  });

  it('fails on a non-2xx answer without the key in the error', async () => {
    sink.respondWith(500, 'no');
    const sender = createSentrySender(deps(), destination(dsnOf(sink.url)));
    const error = await sender.send(event(), {}).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain(KEY);
  });

  it('refuses a host the SSRF policy blocks', async () => {
    const sender = createSentrySender(deps('default'), destination(dsnOf(sink.url)));
    await expect(sender.send(event(), {})).rejects.toThrow();
    expect(sink.requests).toHaveLength(0);
  });

  it('does not follow a 307 and fails the send', async () => {
    sink.respondWith(307);
    const sender = createSentrySender(deps(), destination(dsnOf(sink.url)));
    await expect(sender.send(event(), {})).rejects.toThrow(/redirect/i);
    expect(sink.requests).toHaveLength(1);
  });

  it('refuses a server certificate the platform does not trust (other-ca.pem)', async () => {
    const sender = createSentrySender(deps(), destination(dsnOf(tlsSink.url)));
    await expect(sender.send(event(), {})).rejects.toThrow();
    expect(tlsSink.requests).toHaveLength(0);
    expect(fixtures.otherCa).toContain('BEGIN CERTIFICATE');
  });
});
