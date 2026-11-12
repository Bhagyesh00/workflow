/**
 * P6-68 (C0, stub (L12)): the demo's OpenTelemetry routes, the REST paths of the server's routes/otel.ts as the
 * editor's `otelApi` calls them (api/endpoints.ts). Every path answers 501 until L12 fills it. Rules L12 keeps,
 * as the server: `otel:manage` on all three, the exporter headers come back blank once saved, and the test trace
 * answers an `OtelTestResult`. State lives per workspace in the registering backend.
 */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

const LANE = 'L12';

/** every OpenTelemetry REST path, method first */
const OTEL_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/otel/settings'],
  ['PUT', '/otel/settings'],
  ['POST', '/otel/test-trace'],
];

export function registerOtelRoutes(backend: MockBackend): void {
  // stub (L12): each route answers 501 until L12 writes it
  for (const [method, path] of OTEL_ROUTES) backend.on(method, path, () => notImplemented(LANE));
}
