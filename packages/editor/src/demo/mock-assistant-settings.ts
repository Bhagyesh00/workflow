/**
 * Demo Assistant settings (P5-71, lane L8): GET and PATCH `/assistant/settings` (`assistantApi.settings`,
 * `patchSettings`) on the in-memory MockBackend, an admin's page. C0 registers nothing.
 */
import type { MockBackend } from './mock-backend';

/** P5-71: registers the demo Assistant settings routes (L8). C0: registers nothing. */
export function registerAssistantSettingsRoutes(_backend: MockBackend): void {}
