/**
 * P6-61 (S5 L5): the syslog destination type. Each transport (UDP, TCP, TLS) delivers an RFC 5424 line to the
 * in-process receiver of test/fakes/syslog.ts on 127.0.0.1; no database, no network beyond 127.0.0.1. The SSRF
 * policy is the platform's own (`HttpClient.resolveAllowedHost`); a test that needs a name resolved gives the
 * sender a spy that returns the pinned lookup. Values are fixed fakes.
 */
import { randomUUID } from 'node:crypto';
import { HttpClient } from '@workflow/core';
import type { SyslogDestinationSettings } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '../src/services/events/stream';
import {
  createSyslogSender,
  validateSyslogSettings,
} from '../src/services/log-streaming/destinations/syslog';
import type { SenderDeps, StoredDestination } from '../src/services/log-streaming/types';
import { loadTlsFixtures } from './fakes/http-sink';
import { type SyslogFake, startSyslogFake } from './fakes/syslog';

let fake: SyslogFake;
const fixtures = loadTlsFixtures();

beforeAll(async () => {
  fake = await startSyslogFake();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.udp.messages.length = 0;
  fake.tcp.lines.length = 0;
  fake.tls.lines.length = 0;
});

interface PinSpy {
  hosts: string[];
  lookups: string[];
}

/** a client whose policy lets 127.0.0.1 through; `pin` maps any host name to 127.0.0.1 through a pinned lookup */
function depsFor(options: { pin?: PinSpy; policy?: 'default' | 'loopback' } = {}): SenderDeps {
  const real = new HttpClient({ ssrf: options.policy === 'default' ? {} : { allow: ['127.0.0.1'] } });
  const pin = options.pin;
  const http = pin
    ? ({
        resolveAllowedHost: async (host: string) => {
          pin.hosts.push(host);
          return {
            addresses: [{ address: '127.0.0.1', family: 4 }],
            lookup: (
              name: string,
              lookupOptions: { all?: boolean },
              callback: (...args: unknown[]) => void,
            ) => {
              pin.lookups.push(name);
              if (lookupOptions?.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
              else callback(null, '127.0.0.1', 4);
            },
          };
        },
      } as unknown as HttpClient)
    : real;
  return { http, credentials: {}, cipher: {}, config: {}, logger: {} } as unknown as SenderDeps;
}

function settingsFor(
  protocol: 'udp' | 'tcp' | 'tls',
  extra: Partial<SyslogDestinationSettings> = {},
): SyslogDestinationSettings {
  const port = protocol === 'udp' ? fake.udp.port : protocol === 'tcp' ? fake.tcp.port : fake.tls.port;
  return {
    host: '127.0.0.1',
    port,
    protocol,
    facility: 16,
    app_name: 'workflow',
    eol: '\n',
    ...(protocol === 'tls' ? { tlsCa: fixtures.ca } : {}),
    ...extra,
  };
}

function destination(settings: SyslogDestinationSettings): StoredDestination {
  return {
    id: randomUUID(),
    tenantId: randomUUID(),
    type: 'syslog',
    label: 'Syslog',
    enabled: true,
    subscribedEvents: ['*'],
    anonymizeAuditMessages: false,
    circuitBreaker: null,
    credentialId: null,
    settings,
    lastError: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as StoredDestination;
}

function eventOf(eventName: string, payload: StreamEvent['payload'] = { workflowId: 'wf-1' }): StreamEvent {
  return {
    id: randomUUID(),
    ts: '2026-11-12T10:00:00.000Z',
    eventName,
    message: eventName,
    payload,
    tenantId: randomUUID(),
  };
}

const LINE = /^<(\d+)>1 (\S+) - (\S+) - (\S+) - (\{.*\})$/;
function parse(line: string) {
  const match = LINE.exec(line);
  expect(match, 'an RFC 5424 line').not.toBeNull();
  const [, pri, timestamp, appName, msgId, json] = match as RegExpExecArray;
  return { pri: Number(pri), timestamp, appName, msgId, body: JSON.parse(json) as Record<string, unknown> };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('delivery', () => {
  it('UDP: one RFC 5424 datagram, Local0 PRI for Debug and Error', async () => {
    const sender = createSyslogSender(depsFor(), destination(settingsFor('udp')));
    await sender.send(eventOf('n8n.workflow.success'), {});
    await sender.send(eventOf('n8n.node.error'), {});
    const [first, second] = await fake.waitFor('udp', 2);
    const a = parse(first);
    expect(a.pri).toBe(16 * 8 + 7);
    expect(a.timestamp).toBe('2026-11-12T10:00:00.000Z');
    expect(a.appName).toBe('workflow');
    expect(a.msgId).toBe('n8n.workflow.success');
    expect(a.body.eventName).toBe('n8n.workflow.success');
    expect(a.body.payload).toEqual({ workflowId: 'wf-1' });
    expect(parse(second).pri).toBe(16 * 8 + 3);
    await sender.close?.();
  });

  it('TCP: newline framing over one connection, the facility reaches PRI, the eol is used', async () => {
    const before = fake.tcp.connections;
    const sender = createSyslogSender(
      depsFor(),
      destination(settingsFor('tcp', { facility: 23, app_name: 'flow-app', eol: '\r\n' })),
    );
    await sender.send(eventOf('n8n.audit.user.login.success'), {});
    await sender.send(eventOf('n8n.workflow.error'), {});
    const [first, second] = await fake.waitFor('tcp', 2);
    expect(parse(first).pri).toBe(23 * 8 + 7);
    expect(parse(first).appName).toBe('flow-app');
    expect(parse(second).pri).toBe(23 * 8 + 3);
    expect(fake.tcp.connections - before).toBe(1);
    await sender.close?.();
  });

  it('TCP: reconnects after the server drops the connection', async () => {
    const before = fake.tcp.connections;
    const sender = createSyslogSender(depsFor(), destination(settingsFor('tcp')));
    await sender.send(eventOf('n8n.workflow.success'), {});
    await fake.waitFor('tcp', 1);
    fake.tcp.dropConnections();
    await pause(100);
    await sender.send(eventOf('n8n.workflow.success'), {});
    await fake.waitFor('tcp', 2);
    expect(fake.tcp.connections - before).toBe(2);
    await sender.close?.();
  });

  it('TLS: delivers when the server certificate is signed by the destination CA', async () => {
    const sender = createSyslogSender(depsFor(), destination(settingsFor('tls', { facility: 3 })));
    await sender.send(eventOf('n8n.workflow.success'), {});
    const [line] = await fake.waitFor('tls', 1);
    expect(parse(line).pri).toBe(3 * 8 + 7);
    await sender.close?.();
  });

  it('TLS: a destination whose CA is other-ca.pem refuses the server signed by ca.pem', async () => {
    const sender = createSyslogSender(
      depsFor(),
      destination(settingsFor('tls', { tlsCa: fixtures.otherCa })),
    );
    await expect(sender.send(eventOf('n8n.workflow.success'), {})).rejects.toThrow();
    await pause(100);
    expect(fake.tls.lines).toEqual([]);
    await sender.close?.();
  });

  it('TLS: checks the name the admin typed (localhost) against the certificate', async () => {
    const pin: PinSpy = { hosts: [], lookups: [] };
    const sender = createSyslogSender(
      depsFor({ pin }),
      destination(settingsFor('tls', { host: 'localhost' })),
    );
    await sender.send(eventOf('n8n.workflow.success'), {});
    await fake.waitFor('tls', 1);
    expect(pin.hosts).toEqual(['localhost']);
    await sender.close?.();
  });

  it('keeps the line to RFC 5424 shape: nil host, process id and structured data, no tenant id', async () => {
    const sender = createSyslogSender(depsFor(), destination(settingsFor('udp', { app_name: '' })));
    const event = eventOf('n8n.workflow.success');
    await sender.send(event, {});
    const [line] = await fake.waitFor('udp', 1);
    expect(line).toMatch(/^<\d+>1 \S+ - workflow - n8n\.workflow\.success - \{/);
    expect(line).not.toContain(event.tenantId);
    await sender.close?.();
  });

  it('the test send waits 500 ms before it answers', async () => {
    const sender = createSyslogSender(depsFor(), destination(settingsFor('tcp')));
    const started = Date.now();
    await sender.send(eventOf('destination.test'), { test: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    await fake.waitFor('tcp', 1);
    await sender.close?.();
  });

  it('a refused connection rejects the send', async () => {
    const sender = createSyslogSender(depsFor(), destination(settingsFor('tcp', { port: 1 })));
    await expect(sender.send(eventOf('n8n.workflow.success'), {})).rejects.toThrow();
    await sender.close?.();
  });

  it('a payload too large for a datagram is cut to a marker, not dropped', async () => {
    const sender = createSyslogSender(depsFor(), destination(settingsFor('udp')));
    await sender.send(eventOf('n8n.workflow.success', { big: 'x'.repeat(100_000) }), {});
    const [line] = await fake.waitFor('udp', 1);
    expect(Buffer.byteLength(line)).toBeLessThan(65_507);
    expect(parse(line).body.payload).toEqual({ truncated: true });
    await sender.close?.();
  });
});

describe('the SSRF guard', () => {
  for (const protocol of ['udp', 'tcp', 'tls'] as const) {
    it(`${protocol}: a blocked host is refused and nothing is sent`, async () => {
      const sender = createSyslogSender(depsFor({ policy: 'default' }), destination(settingsFor(protocol)));
      await expect(sender.send(eventOf('n8n.workflow.success'), {})).rejects.toThrow(/blocked/);
      await pause(100);
      expect(fake.udp.messages).toEqual([]);
      expect(fake.tcp.lines).toEqual([]);
      expect(fake.tls.lines).toEqual([]);
      await sender.close?.();
    });
  }

  it('UDP: the host is resolved and checked on every send', async () => {
    const pin: PinSpy = { hosts: [], lookups: [] };
    const sender = createSyslogSender(
      depsFor({ pin }),
      destination(settingsFor('udp', { host: 'logs.example.test' })),
    );
    await sender.send(eventOf('n8n.workflow.success'), {});
    await sender.send(eventOf('n8n.workflow.success'), {});
    await fake.waitFor('udp', 2);
    expect(pin.hosts).toEqual(['logs.example.test', 'logs.example.test']);
    await sender.close?.();
  });

  it('TCP: the socket connects through the pinned lookup of the checked host', async () => {
    const pin: PinSpy = { hosts: [], lookups: [] };
    const sender = createSyslogSender(
      depsFor({ pin }),
      destination(settingsFor('tcp', { host: 'logs.example.test' })),
    );
    await sender.send(eventOf('n8n.workflow.success'), {});
    await fake.waitFor('tcp', 1);
    expect(pin.hosts).toEqual(['logs.example.test']);
    // the name never reached the system resolver: the pinned lookup answered it
    expect(pin.lookups).toEqual(['logs.example.test']);
    await sender.close?.();
  });
});

describe('validateSyslogSettings', () => {
  const good = {
    host: 'logs.example.test',
    port: 514,
    protocol: 'udp',
    facility: 16,
    app_name: 'workflow',
    eol: '\n',
  };

  it('accepts the editor defaults for each protocol', () => {
    expect(validateSyslogSettings(good)).toBeNull();
    expect(validateSyslogSettings({ ...good, protocol: 'tcp' })).toBeNull();
    expect(validateSyslogSettings({ ...good, protocol: 'tls', tlsCa: fixtures.ca })).toBeNull();
    expect(validateSyslogSettings({ ...good, eol: '\r\n' })).toBeNull();
  });

  it('refuses TLS without a CA', () => {
    expect(validateSyslogSettings({ ...good, protocol: 'tls' })).toBe('A CA certificate is required for TLS');
    expect(validateSyslogSettings({ ...good, protocol: 'tls', tlsCa: '   ' })).toBe(
      'A CA certificate is required for TLS',
    );
    expect(validateSyslogSettings({ ...good, protocol: 'tls', tlsCa: 'not a certificate' })).toBe(
      'The CA certificate must be a PEM certificate',
    );
  });

  it('refuses a bad host, port, protocol, facility, app name and eol', () => {
    expect(validateSyslogSettings(null)).not.toBeNull();
    expect(validateSyslogSettings({ ...good, host: '  ' })).toBe('The syslog host is required');
    expect(validateSyslogSettings({ ...good, host: 'a b' })).not.toBeNull();
    expect(validateSyslogSettings({ ...good, host: 'http://x.test' })).not.toBeNull();
    expect(validateSyslogSettings({ ...good, port: 0 })).toBe('The port must be between 1 and 65535');
    expect(validateSyslogSettings({ ...good, port: 70000 })).toBe('The port must be between 1 and 65535');
    expect(validateSyslogSettings({ ...good, protocol: 'http' })).toBe(
      'The protocol must be udp, tcp or tls',
    );
    expect(validateSyslogSettings({ ...good, facility: 24 })).toBe('The facility must be between 0 and 23');
    expect(validateSyslogSettings({ ...good, facility: 1.5 })).toBe('The facility must be between 0 and 23');
    expect(validateSyslogSettings({ ...good, app_name: 'has space' })).not.toBeNull();
    expect(validateSyslogSettings({ ...good, app_name: 'x'.repeat(49) })).not.toBeNull();
    expect(validateSyslogSettings({ ...good, eol: 'x' })).toBe('The line ending must be LF or CRLF');
  });
});
