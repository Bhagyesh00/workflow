/**
 * P6-57 (C0): the demo's Insights: the summary tiles, the by-time and by-workflow lists and the Insights settings.
 * The routes answer 501 until L13 fills them. L13 owns this file after C0.
 */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

export function registerInsightsRoutes(backend: MockBackend): void {
  // stub (L13)
  backend.on('GET', '/insights/summary', () => notImplemented('L13'));
  backend.on('GET', '/insights/by-workflow', () => notImplemented('L13'));
  backend.on('GET', '/insights/by-time', () => notImplemented('L13'));
  backend.on('GET', '/insights/by-time/time-saved', () => notImplemented('L13'));
  backend.on('GET', '/insights/settings', () => notImplemented('L13'));
}
