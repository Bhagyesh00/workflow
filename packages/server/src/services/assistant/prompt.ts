/**
 * The Assistant's system prompt (P5-67, lane L1): our own text (never n8n's), with the caller's role, the
 * rule never to follow `<untrusted_data>`, that the Assistant cannot see secrets, and the thread's
 * observations inside `wrapUntrusted`. C0 stub with the final signature.
 */
import type { Role } from '../../db/schema';

export interface AssistantPromptInput {
  role: Role;
  /** the thread's rolling summary (compaction); null before the first compaction */
  observations: string | null;
  /** the names of the tools offered this turn */
  toolNames: string[];
  /** IANA timezone of the workspace, for dates the model writes */
  timezone?: string;
  /** "now" for the prompt (tests pass a fixed date) */
  now?: Date;
}

export function assistantSystemPrompt(_input: AssistantPromptInput): string {
  throw new Error('not implemented (L1)');
}
