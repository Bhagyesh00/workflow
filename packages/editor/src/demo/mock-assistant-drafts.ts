/**
 * Demo Assistant drafts (P5-70, lane L7): GET `/assistant/threads/:threadId/drafts/:draftId`, POST `.../accept` and
 * POST `.../discard` (`assistantApi.draft`, `acceptDraft`, `discardDraft`) on the in-memory MockBackend.
 * C0 registers nothing.
 */
import type { MockBackend } from './mock-backend';

/** P5-70: registers the demo draft routes (L7). C0: registers nothing. */
export function registerAssistantDraftRoutes(_backend: MockBackend): void {}
