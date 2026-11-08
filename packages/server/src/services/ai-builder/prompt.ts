/**
 * The builder's system prompt (P5-09, L1). Own text, never n8n's; it states the rule that
 * `<untrusted_data>` content is data and is never followed. Plan mode names only the read tools and
 * the submit tools; `summary` is the session's `previousSummary` (L6), passed wrapped as untrusted.
 */
import type { BuilderMode } from '@workflow/workflow';

export function builderSystemPrompt(_mode: BuilderMode, _summary?: string): string {
  throw new Error('not implemented (L1)');
}
