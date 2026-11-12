/**
 * P6-65 / P6-69 (S5 L13): the one wire test against a real collector, the `otel-collector` service of
 * docker/docker-compose.dev.yml (profile brokers; 127.0.0.1:4317 gRPC, 127.0.0.1:4318 HTTP). It exports one span
 * over OTLP/HTTP protobuf and one over gRPC (h2c) with our own encoder and clients, and reads both back from the
 * collector's file exporter, docker/otel-out/traces.json on the host (one JSON line per batch). It skips when a TCP
 * connect to 127.0.0.1:4318 fails within 1 s. No header value, no secret: the spans carry fixed fake values only.
 */
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { HttpClient } from '@workflow/core';
import { describe, expect, it, vi } from 'vitest';
import type { ServerContext, ServiceDeps } from '../src/context';
import { exportSpans } from '../src/services/tracing/exporter';
import { randomSpanId, randomTraceId } from '../src/services/tracing/ids';
import type { EffectiveOtelSettings } from '../src/services/tracing/settings';
import { nowUnixNano, type SpanData } from '../src/services/tracing/span';

const COLLECTOR_HOST = '127.0.0.1';
const HTTP_PORT = 4318;
const GRPC_PORT = 4317;
const OUT_FILE = path.join(__dirname, '..', '..', '..', 'docker', 'otel-out', 'traces.json');

function probe(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, COLLECTOR_HOST);
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const collectorUp = await probe(HTTP_PORT, 1000);

function makeDeps(): ServiceDeps {
  const http = new HttpClient({ ssrf: { allow: [COLLECTOR_HOST] } });
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    config: { version: '0.0.0-wire' },
    logger,
    context: () => ({ http, instance: { id: 'wire-instance', role: 'main' } }) as unknown as ServerContext,
  } as unknown as ServiceDeps;
}

function settingsFor(
  protocol: EffectiveOtelSettings['exporterProtocol'],
  endpoint: string,
  serviceName: string,
): EffectiveOtelSettings {
  return {
    tenantId: 'tenant-wire',
    enabled: true,
    exporterProtocol: protocol,
    exporterEndpoint: endpoint,
    exporterTracingPath: '/v1/traces',
    exporterServiceName: serviceName,
    tracesSampleRate: 1,
    startupConnectivityTimeoutMs: 2000,
    includeNodeSpans: true,
    emitWorkflowStartSpan: false,
    emitNodeStartSpan: false,
    injectOutbound: true,
    productionExecutionsOnly: false,
    headers: { 'x-wire-test': 'fake-wire-value' },
  };
}

function spansFor(traceId: string, rootId: string, childId: string): SpanData[] {
  const start = nowUnixNano();
  const base = {
    tenantId: 'tenant-wire',
    kind: 'internal' as const,
    startTimeUnixNano: start,
    endTimeUnixNano: start + 1_000_000n,
    events: [],
    links: [],
    status: { code: 'ok' as const },
  };
  return [
    {
      ...base,
      name: 'workflow.execute',
      context: { traceId, spanId: rootId, traceFlags: 1 },
      attributes: {},
    },
    {
      ...base,
      name: 'node.execute',
      context: { traceId, spanId: childId, traceFlags: 1 },
      parentSpanId: rootId,
      attributes: { 'node.type': 'wire.test' },
    },
  ];
}

interface FileSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
}

interface FileBatch {
  resourceSpans?: Array<{
    resource?: { attributes?: Array<{ key: string; value: { stringValue?: string } }> };
    scopeSpans?: Array<{ scope?: { name?: string }; spans?: FileSpan[] }>;
  }>;
}

/** the spans of `traceId` the file exporter wrote, with their resource's service.name and scope name */
function spansInFile(traceId: string): Array<FileSpan & { service?: string; scope?: string }> {
  if (!existsSync(OUT_FILE)) return [];
  const found: Array<FileSpan & { service?: string; scope?: string }> = [];
  for (const line of readFileSync(OUT_FILE, 'utf8').split('\n')) {
    if (!line.includes(traceId)) continue;
    let batch: FileBatch;
    try {
      batch = JSON.parse(line) as FileBatch;
    } catch {
      continue;
    }
    for (const rs of batch.resourceSpans ?? []) {
      const service = rs.resource?.attributes?.find((a) => a.key === 'service.name')?.value.stringValue;
      for (const ss of rs.scopeSpans ?? []) {
        for (const s of ss.spans ?? []) {
          if (s.traceId === traceId) found.push({ ...s, service, scope: ss.scope?.name });
        }
      }
    }
  }
  return found;
}

async function waitForSpans(traceId: string, count: number, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = spansInFile(traceId);
    if (found.length >= count || Date.now() > deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function exportAndReadBack(protocol: EffectiveOtelSettings['exporterProtocol'], port: number) {
  const traceId = randomTraceId();
  const rootId = randomSpanId();
  const childId = randomSpanId();
  const serviceName = `wire-${protocol === 'grpc' ? 'grpc' : 'http'}-${traceId.slice(0, 8)}`;
  const result = await exportSpans(
    makeDeps(),
    settingsFor(protocol, `http://${COLLECTOR_HOST}:${port}`, serviceName),
    spansFor(traceId, rootId, childId),
  );
  expect(result).toEqual({ success: true });

  const found = await waitForSpans(traceId, 2);
  expect(found.map((s) => s.name).sort()).toEqual(['node.execute', 'workflow.execute']);
  const root = found.find((s) => s.name === 'workflow.execute');
  const child = found.find((s) => s.name === 'node.execute');
  expect(root?.spanId).toBe(rootId);
  expect(root?.parentSpanId ?? '').toBe('');
  expect(child?.spanId).toBe(childId);
  expect(child?.parentSpanId).toBe(rootId);
  expect(child?.service).toBe(serviceName);
  expect(child?.scope).toBe('workflow');
}

describe.skipIf(!collectorUp)('otel collector wire', () => {
  it('a span batch over OTLP/HTTP protobuf reaches the collector and its file exporter', async () => {
    await exportAndReadBack('http/protobuf', HTTP_PORT);
  });

  it('a span batch over OTLP/gRPC (h2c) reaches the collector and its file exporter', async () => {
    await exportAndReadBack('grpc', GRPC_PORT);
  });
});
