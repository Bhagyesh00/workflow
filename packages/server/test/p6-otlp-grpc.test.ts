/**
 * P6-69 (S5 L13): OTLP over gRPC. `exportGrpc` (and `exportSpans` / `sendTestTrace` with `exporterProtocol: 'grpc'`)
 * against the in-process `node:http2` collector of test/fakes/otlp-grpc.ts on 127.0.0.1 (an ephemeral port), h2c
 * and TLS with the PEM pair of test/fixtures/tls, through our own `HttpClient`s: one that allows 127.0.0.1 for the
 * fake, one with no allow list for the guard refusal. No internet, no real collector. Header values are fixed fakes;
 * tests assert on what the fake captured and never print them.
 */
import tls from 'node:tls';
import { HttpClient } from '@workflow/core';
import { describe, expect, it, vi } from 'vitest';
import type { ServerContext, ServiceDeps } from '../src/context';
import { exportSpans, sendExportBody } from '../src/services/tracing/exporter';
import { exportGrpc, GRPC_TRACE_EXPORT_PATH } from '../src/services/tracing/exporter-grpc';
import type { EffectiveOtelSettings } from '../src/services/tracing/settings';
import type { SpanData } from '../src/services/tracing/span';
import { sendTestTrace } from '../src/services/tracing/test-trace';
import { loadTlsFixtures } from './fakes/http-sink';
import { startOtlpGrpcCollector } from './fakes/otlp-grpc';

const HEADER_VALUE = 'fake-otlp-grpc-header-l13';
const SECOND_VALUE = 'fake-second-grpc-value-l13';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const ROOT_ID = '00f067aa0ba902b7';
const CHILD_ID = '53995c3f42cd8ad8';

function makeDeps(http: HttpClient = new HttpClient({ ssrf: { allow: ['127.0.0.1'] } })) {
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    config: { version: '9.8.7' },
    logger,
    context: () => ({ http, instance: { id: 'instance-1', role: 'main' } }) as unknown as ServerContext,
  } as unknown as ServiceDeps;
}

function settingsFor(endpoint: string, over: Partial<EffectiveOtelSettings> = {}): EffectiveOtelSettings {
  return {
    tenantId: 'tenant-a',
    enabled: true,
    exporterProtocol: 'grpc',
    exporterEndpoint: endpoint,
    exporterTracingPath: '/v1/traces',
    exporterServiceName: 'grpc-service',
    tracesSampleRate: 1,
    startupConnectivityTimeoutMs: 2000,
    includeNodeSpans: true,
    emitWorkflowStartSpan: false,
    emitNodeStartSpan: false,
    injectOutbound: true,
    productionExecutionsOnly: false,
    headers: { 'x-api-key': HEADER_VALUE, 'X-Second': SECOND_VALUE },
    ...over,
  };
}

function span(name: string, spanId: string, parentSpanId?: string): SpanData {
  return {
    tenantId: 'tenant-a',
    name,
    kind: 'internal',
    context: { traceId: TRACE_ID, spanId, traceFlags: 1 },
    ...(parentSpanId ? { parentSpanId } : {}),
    startTimeUnixNano: 1_762_000_000_000_000_000n,
    endTimeUnixNano: 1_762_000_000_250_000_000n,
    attributes: { 'workflow.id': 'w1' },
    events: [],
    links: [],
    status: { code: 'ok' },
  };
}

const spans = () => [span('workflow.execute', ROOT_ID), span('node.execute', CHILD_ID, ROOT_ID)];

describe('exportGrpc over h2c', () => {
  it('the fake receives the spans with their parents: unary Export, gRPC framing, headers as metadata', async () => {
    const collector = await startOtlpGrpcCollector();
    try {
      const result = await exportSpans(makeDeps(), settingsFor(collector.url), spans());
      expect(result).toEqual({ success: true });
      expect(collector.requests).toHaveLength(1);
      const [request] = collector.requests;
      expect(request.method).toBe('POST');
      expect(request.path).toBe(GRPC_TRACE_EXPORT_PATH);
      expect(request.path).toBe('/opentelemetry.proto.collector.trace.v1.TraceService/Export');
      expect(request.headers[':scheme']).toBe('http');
      expect(request.headers['content-type']).toBe('application/grpc');
      expect(request.headers.te).toBe('trailers');
      // metadata names are lower case; compare without printing
      expect(request.headers['x-api-key'] === HEADER_VALUE).toBe(true);
      expect(request.headers['x-second'] === SECOND_VALUE).toBe(true);
      // one uncompressed message whose 4-byte length matches the body
      expect(request.frames).toHaveLength(1);
      expect(request.frames[0].compressed).toBe(false);
      expect(request.body.readUInt32BE(1)).toBe(request.body.length - 5);

      const received = collector.spans();
      expect(received.map((s) => s.name)).toEqual(['workflow.execute', 'node.execute']);
      const [root, child] = received;
      expect(root.traceId).toBe(TRACE_ID);
      expect(root.spanId).toBe(ROOT_ID);
      expect(root.parentSpanId).toBe('');
      expect(child.traceId).toBe(TRACE_ID);
      expect(child.spanId).toBe(CHILD_ID);
      expect(child.parentSpanId).toBe(ROOT_ID);
      expect(child.resource['service.name']).toBe('grpc-service');
      expect(child.resource['service.version']).toBe('9.8.7');
      expect(child.scope.name).toBe('workflow');
    } finally {
      await collector.close();
    }
  });

  it('a settings header cannot replace the gRPC content type, te or the path', async () => {
    const collector = await startOtlpGrpcCollector();
    try {
      const result = await exportGrpc(
        makeDeps(),
        settingsFor(collector.url, {
          headers: {
            'content-type': 'text/plain',
            te: 'gzip',
            ':path': '/other',
            'grpc-timeout': '1n',
            connection: 'close',
            authorization: HEADER_VALUE,
          },
        }),
        new Uint8Array(0),
      );
      expect(result).toEqual({ success: true });
      const [request] = collector.requests;
      expect(request.path).toBe(GRPC_TRACE_EXPORT_PATH);
      expect(request.headers['content-type']).toBe('application/grpc');
      expect(request.headers.te).toBe('trailers');
      expect(request.headers['grpc-timeout']).not.toBe('1n');
      expect(request.headers.authorization === HEADER_VALUE).toBe(true);
    } finally {
      await collector.close();
    }
  });

  it('the startup probe sends an empty request: one zero-length message', async () => {
    const collector = await startOtlpGrpcCollector();
    try {
      const outcome = await sendExportBody(makeDeps(), settingsFor(collector.url), new Uint8Array(0), 2000);
      expect(outcome).toEqual({ success: true, status: 200 });
      const [request] = collector.requests;
      expect(request.body.equals(Buffer.alloc(5))).toBe(true);
      expect(request.frames).toEqual([{ compressed: false, message: Buffer.alloc(0) }]);
    } finally {
      await collector.close();
    }
  });

  it('sendTestTrace over gRPC: the test collector receives the test span', async () => {
    const collector = await startOtlpGrpcCollector();
    try {
      const result = await sendTestTrace(makeDeps(), settingsFor(`${collector.url}/`));
      expect(result).toEqual({ success: true });
      expect(collector.spans().map((s) => s.name)).toEqual(['test_trace']);
    } finally {
      await collector.close();
    }
  });
});

describe('exportGrpc errors', () => {
  it('grpc-status 16 in the trailers gives its message as the error, with no header value', async () => {
    const collector = await startOtlpGrpcCollector();
    collector.respondWith({ grpcStatus: 16, grpcMessage: `bad key ${HEADER_VALUE} (100% wrong)` });
    try {
      const result = await exportSpans(makeDeps(), settingsFor(collector.url), spans());
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^16 UNAUTHENTICATED: bad key .* \(100% wrong\)$/);
      expect(result.error?.includes(HEADER_VALUE)).toBe(false);
      expect(collector.requests).toHaveLength(1);
    } finally {
      await collector.close();
    }
  });

  it('a trailers-only answer gives its status and message', async () => {
    const collector = await startOtlpGrpcCollector();
    collector.respondWith({ grpcStatus: 16, grpcMessage: 'missing credentials', trailersOnly: true });
    try {
      const direct = await exportGrpc(makeDeps(), settingsFor(collector.url), new Uint8Array(0));
      expect(direct).toEqual({ success: false, error: '16 UNAUTHENTICATED: missing credentials' });
      const viaTestTrace = await sendTestTrace(makeDeps(), settingsFor(collector.url));
      expect(viaTestTrace).toEqual({ success: false, error: '16 UNAUTHENTICATED: missing credentials' });
    } finally {
      await collector.close();
    }
  });

  it('a non-200 HTTP status and a status with no message are errors', async () => {
    const collector = await startOtlpGrpcCollector();
    try {
      collector.respondWith({ httpStatus: 503, grpcStatus: 14 });
      const http = await exportGrpc(makeDeps(), settingsFor(collector.url), new Uint8Array(0));
      expect(http.success).toBe(false);
      expect(http.error).toMatch(/503/);

      collector.respondWith({ grpcStatus: 14 });
      const unavailable = await exportGrpc(makeDeps(), settingsFor(collector.url), new Uint8Array(0));
      expect(unavailable).toEqual({ success: false, error: '14 UNAVAILABLE' });
    } finally {
      await collector.close();
    }
  });

  it('a collector that never answers fails after the timeout, never a throw', async () => {
    const collector = await startOtlpGrpcCollector();
    collector.respondWith({ hang: true });
    try {
      const started = Date.now();
      const result = await exportGrpc(makeDeps(), settingsFor(collector.url), new Uint8Array(0), {
        timeoutMs: 300,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/did not answer within 300 ms/);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await collector.close();
    }
  });

  it('a blocked host is refused before any connection', async () => {
    const collector = await startOtlpGrpcCollector();
    try {
      const guarded = makeDeps(new HttpClient());
      const loopback = await exportSpans(guarded, settingsFor(collector.url), spans());
      expect(loopback.success).toBe(false);
      expect(loopback.error).toMatch(/is blocked/);
      const internal = await exportGrpc(guarded, settingsFor('https://10.1.2.3:4317'), new Uint8Array(0));
      expect(internal.success).toBe(false);
      expect(internal.error).toMatch(/10\.1\.2\.3.*is blocked/);
      expect(collector.requests).toHaveLength(0);
    } finally {
      await collector.close();
    }
  });

  it('an endpoint that is not http:// or https:// is refused', async () => {
    const result = await exportGrpc(makeDeps(), settingsFor('grpc://127.0.0.1:4317'), new Uint8Array(0));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/http:\/\/ or https:\/\//);
    const empty = await exportGrpc(makeDeps(), settingsFor(''), new Uint8Array(0));
    expect(empty.success).toBe(false);
  });

  it('an unreachable collector gives an error, never a throw', async () => {
    const collector = await startOtlpGrpcCollector();
    const { url } = collector;
    await collector.close();
    const result = await exportGrpc(makeDeps(), settingsFor(url), new Uint8Array(0));
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('exportGrpc over TLS', () => {
  it('a self-signed TLS server (its CA not in the store) is refused; trusting its CA accepts it', async () => {
    const fixtures = loadTlsFixtures();
    const collector = await startOtlpGrpcCollector({ tls: { key: fixtures.key, cert: fixtures.cert } });
    const system = tls.getCACertificates('default');
    try {
      const refused = await exportSpans(makeDeps(), settingsFor(collector.url), spans());
      expect(refused.success).toBe(false);
      expect(refused.error).toMatch(/certificate/i);
      expect(collector.requests).toHaveLength(0);

      tls.setDefaultCACertificates([...system, fixtures.otherCa]);
      const otherCa = await exportSpans(makeDeps(), settingsFor(collector.url), spans());
      expect(otherCa.success).toBe(false);
      expect(collector.requests).toHaveLength(0);

      // the signing CA: accepted, so the refusals above are the certificate check
      tls.setDefaultCACertificates([...system, fixtures.ca]);
      const accepted = await exportSpans(makeDeps(), settingsFor(collector.url), spans());
      expect(accepted).toEqual({ success: true });
      expect(collector.requests).toHaveLength(1);
      expect(collector.requests[0].headers[':scheme']).toBe('https');
      expect(collector.spans().map((s) => s.parentSpanId)).toEqual(['', ROOT_ID]);

      // a host name: the certificate is checked against it (servername), the socket still goes to the pinned address
      const byName = await exportGrpc(
        makeDeps(new HttpClient({ ssrf: { allow: ['localhost', '127.0.0.1', '::1'] } })),
        settingsFor(`https://localhost:${collector.port}`),
        new Uint8Array(0),
      );
      expect(byName).toEqual({ success: true });
      expect(collector.requests[1].headers[':authority']).toBe(`localhost:${collector.port}`);
    } finally {
      tls.setDefaultCACertificates(system);
      await collector.close();
    }
  });
});
