/**
 * P6-65 (S5 L9): OTLP over HTTP: `exportSpans` and `sendTestTrace` against the in-process collector of
 * test/fakes/otlp.ts on 127.0.0.1 (an ephemeral port), through our own `HttpClient`s: one that allows 127.0.0.1
 * for the fake, one with no allow list for the guard refusals. TLS uses the PEM pair of test/fixtures/tls. No
 * internet, no real collector. Header values are fixed fakes; tests assert on what the fake captured and never
 * print them.
 */
import tls from 'node:tls';
import { HttpClient } from '@workflow/core';
import { describe, expect, it, vi } from 'vitest';
import type { ServerContext, ServiceDeps } from '../src/context';
import { exportSpans } from '../src/services/tracing/exporter';
import { BatchSpanProcessor } from '../src/services/tracing/processor';
import type { EffectiveOtelSettings } from '../src/services/tracing/settings';
import type { SpanData } from '../src/services/tracing/span';
import { sendTestTrace } from '../src/services/tracing/test-trace';
import { loadTlsFixtures } from './fakes/http-sink';
import { startOtlpCollector } from './fakes/otlp';

const HEADER_VALUE = 'fake-otlp-header-value-l9';
const SECOND_VALUE = 'fake-second-value-l9';

function makeDeps(http: HttpClient = new HttpClient({ ssrf: { allow: ['127.0.0.1'] } })) {
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    config: { version: '9.8.7' },
    logger,
    context: () => ({ http, instance: { id: 'instance-1', role: 'worker' } }) as unknown as ServerContext,
  } as unknown as ServiceDeps;
}

function settingsFor(endpoint: string, over: Partial<EffectiveOtelSettings> = {}): EffectiveOtelSettings {
  return {
    tenantId: 'tenant-a',
    enabled: true,
    exporterProtocol: 'http/protobuf',
    exporterEndpoint: endpoint,
    exporterTracingPath: '/v1/traces',
    exporterServiceName: 'my-service',
    tracesSampleRate: 1,
    startupConnectivityTimeoutMs: 2000,
    includeNodeSpans: true,
    emitWorkflowStartSpan: false,
    emitNodeStartSpan: false,
    injectOutbound: true,
    productionExecutionsOnly: false,
    headers: { 'x-api-key': HEADER_VALUE, 'x-second': SECOND_VALUE },
    ...over,
  };
}

function span(name: string): SpanData {
  return {
    tenantId: 'tenant-a',
    name,
    kind: 'internal',
    context: { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', traceFlags: 1 },
    startTimeUnixNano: 1_762_000_000_000_000_000n,
    endTimeUnixNano: 1_762_000_000_500_000_000n,
    attributes: { 'workflow.id': 'w1' },
    events: [],
    links: [],
    status: { code: 'ok' },
  };
}

describe('exportSpans over HTTP protobuf', () => {
  it('POSTs endpoint + path with the protobuf type, the settings headers and the resource attributes', async () => {
    const collector = await startOtlpCollector();
    try {
      const result = await exportSpans(
        makeDeps(),
        settingsFor(`${collector.url}/`, { exporterTracingPath: 'v1/traces' }),
        [span('workflow.execute'), span('node.execute')],
      );
      expect(result).toEqual({ success: true });
      expect(collector.requests).toHaveLength(1);
      const [request] = collector.requests;
      expect(request.method).toBe('POST');
      expect(request.path).toBe('/v1/traces');
      expect(request.headers['content-type']).toBe('application/x-protobuf');
      expect(request.headers['x-api-key']).toBe(HEADER_VALUE);
      expect(request.headers['x-second']).toBe(SECOND_VALUE);
      const spans = collector.spans();
      expect(spans.map((s) => s.name)).toEqual(['workflow.execute', 'node.execute']);
      // n8n's resource attributes without `n8n.`, and no tenant id (each tenant's collector gets only its spans)
      expect(spans[0].resource).toEqual({
        'service.name': 'my-service',
        'service.version': '9.8.7',
        'instance.id': 'instance-1',
        'instance.role': 'worker',
      });
      expect(spans[0].attributes).toEqual({ 'workflow.id': 'w1' });
    } finally {
      await collector.close();
    }
  });

  it('a batch processor exports through the collector on flush', async () => {
    const collector = await startOtlpCollector();
    try {
      const processor = new BatchSpanProcessor(makeDeps(), settingsFor(collector.url));
      processor.onEnd(span('one'));
      processor.onEnd(span('two'));
      await processor.shutdown();
      expect(collector.spans().map((s) => s.name)).toEqual(['one', 'two']);
    } finally {
      await collector.close();
    }
  });

  it('a non-2xx gives the status text, redacted, without header values, cut to 1000 characters', async () => {
    const collector = await startOtlpCollector();
    try {
      collector.respondWith({
        status: 400,
        body: `bad ${HEADER_VALUE} Bearer abcdefghijklmnopqrstuvwxyz0123 ${'z'.repeat(3000)}`,
        headers: { 'content-type': 'text/plain' },
      });
      const result = await exportSpans(makeDeps(), settingsFor(collector.url), [span('x')]);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^400 Bad Request/);
      expect(result.error).not.toContain(HEADER_VALUE);
      expect(result.error).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
      expect((result.error as string).length).toBeLessThanOrEqual(1000);
    } finally {
      await collector.close();
    }
  });

  it('a 307 to 127.0.0.1 is not followed and the export fails', async () => {
    const collector = await startOtlpCollector();
    try {
      collector.respondWith({ status: 307, headers: { location: `${collector.url}/elsewhere` } });
      const result = await exportSpans(makeDeps(), settingsFor(collector.url), [span('x')]);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/307/);
      expect(collector.requests).toHaveLength(1);
      expect(collector.requests[0].path).toBe('/v1/traces');
    } finally {
      await collector.close();
    }
  });

  it('a collector at a blocked address is refused by the SSRF guard', async () => {
    const collector = await startOtlpCollector();
    try {
      const deps = makeDeps(new HttpClient());
      const loopback = await exportSpans(deps, settingsFor(collector.url), [span('x')]);
      expect(loopback.success).toBe(false);
      expect(loopback.error).toMatch(/blocked/);
      const privateHost = await sendTestTrace(deps, settingsFor('http://10.1.2.3:4318'));
      expect(privateHost.success).toBe(false);
      expect(privateHost.error).toMatch(/blocked/);
      expect(collector.requests).toHaveLength(0);
    } finally {
      await collector.close();
    }
  });

  it('TLS is verified: a certificate the trusted CAs did not sign is refused; the signing CA is accepted', async () => {
    const fixtures = loadTlsFixtures();
    const collector = await startOtlpCollector({ tls: { key: fixtures.key, cert: fixtures.cert } });
    const system = tls.getCACertificates('default');
    try {
      // trust other-ca.pem: the collector's certificate (signed by ca.pem) is refused
      tls.setDefaultCACertificates([...system, fixtures.otherCa]);
      const refused = await sendTestTrace(makeDeps(), settingsFor(collector.url));
      expect(refused.success).toBe(false);
      expect(refused.error).toBeTruthy();
      expect(collector.requests).toHaveLength(0);

      // trust ca.pem: the same collector is accepted, so the refusal above is the certificate check
      tls.setDefaultCACertificates([...system, fixtures.ca]);
      const accepted = await sendTestTrace(makeDeps(), settingsFor(collector.url));
      expect(accepted).toEqual({ success: true });
      expect(collector.requests).toHaveLength(1);
    } finally {
      tls.setDefaultCACertificates(system);
      await collector.close();
    }
  });
});

describe('sendTestTrace', () => {
  it('the test collector receives the test span', async () => {
    const collector = await startOtlpCollector();
    try {
      const result = await sendTestTrace(makeDeps(), settingsFor(collector.url));
      expect(result).toEqual({ success: true });
      const spans = await collector.waitForSpans(1);
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe('test_trace');
      expect(spans[0].attributes).toEqual({ test: true });
      expect(spans[0].kind).toBe(1);
      expect(spans[0].traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(spans[0].parentSpanId).toBe('');
      expect(spans[0].endTimeUnixNano >= spans[0].startTimeUnixNano).toBe(true);
      expect(spans[0].resource['service.name']).toBe('my-service');
      expect(collector.requests[0].headers['x-api-key']).toBe(HEADER_VALUE);
    } finally {
      await collector.close();
    }
  });

  it("a 401 gives the collector's text", async () => {
    const collector = await startOtlpCollector();
    try {
      collector.respondWith({
        status: 401,
        body: 'invalid api key',
        headers: { 'content-type': 'text/plain' },
      });
      const result = await sendTestTrace(makeDeps(), settingsFor(collector.url));
      expect(result).toEqual({ success: false, error: '401 Unauthorized: invalid api key' });
    } finally {
      await collector.close();
    }
  });

  it('a protobuf google.rpc.Status answer gives its message', async () => {
    const collector = await startOtlpCollector();
    try {
      // Status { code (1) = 16, message (2) = "token expired" }
      const message = Buffer.from('token expired');
      collector.respondWith({
        status: 401,
        body: Buffer.concat([Buffer.from([0x08, 16, 0x12, message.length]), message]),
      });
      const result = await sendTestTrace(makeDeps(), settingsFor(collector.url));
      expect(result).toEqual({ success: false, error: '401 Unauthorized: token expired' });
    } finally {
      await collector.close();
    }
  });

  it('an unreachable collector gives an error, never a throw', async () => {
    const collector = await startOtlpCollector();
    const url = collector.url;
    await collector.close();
    const result = await sendTestTrace(makeDeps(), settingsFor(url));
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error).not.toContain(HEADER_VALUE);
  });
});
