/**
 * Demo Assistant confirmations (P5-68, lane L3): POST `/assistant/confirm/:requestId` (`assistantApi.confirm`,
 * the body is the `AssistantConfirmAnswer`) on the in-memory MockBackend, resolving a pending card of a demo
 * thread and playing the `confirmation-resolved` event and the rest of the turn. C0 registers nothing.
 */
import type { MockBackend } from './mock-backend';

/** P5-68: registers the demo confirm route (L3). C0: registers nothing. */
export function registerAssistantConfirmRoutes(_backend: MockBackend): void {}
