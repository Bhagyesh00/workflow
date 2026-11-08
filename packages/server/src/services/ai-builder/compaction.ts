/**
 * Session compaction (P5-66, L6). `maybeCompact` is a seam `builder.ts` calls from the start; until L6
 * fills it, it does nothing. L6: at `BUILDER_COMPACT_TOKENS` estimated tokens, one model call with an
 * own prompt replaces `previousSummary`, keeps the messages short and emits `session-messages`; an
 * existing summary is wrapped as untrusted when sent.
 * `estimateTokens` is FULL from C0 (L1 reads it).
 */
import type { AiChatModel, BuilderChunk } from '@workflow/workflow';
import type { BuilderSession } from './types';

export interface MaybeCompactInput {
  session: BuilderSession;
  model: AiChatModel;
  signal: AbortSignal;
  emit: (chunk: BuilderChunk) => void;
}

/** C0 does nothing */
export async function maybeCompact(_input: MaybeCompactInput): Promise<void> {}

/** characters per token of the estimate (the usual rough figure for English text and JSON) */
export const CHARS_PER_TOKEN = 4;

/** a rough token count of `text`: one token per 4 characters, rounded up; 0 for empty text */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
