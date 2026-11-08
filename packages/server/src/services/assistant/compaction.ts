/**
 * Thread compaction (P5-67, lane L1): one rolling `observations` text per thread. At
 * `INSTANCE_AI_OBSERVER_MESSAGE_TOKENS` (estimated with `estimateTokens`) one model call folds the oldest
 * messages (never a tool call apart from its result) into `observations` and marks them `summarized`; at
 * `INSTANCE_AI_REFLECTOR_OBSERVATION_TOKENS` a second call condenses `observations`. Messages stay for
 * the UI; only the model's view shrinks. C0 stub with the final signature.
 */
import type { AiChatModel } from '@workflow/workflow';
import type { ServerContext } from '../../context';
import type { AssistantRunScope } from './types';

export interface CompactInput {
  ctx: ServerContext;
  run: AssistantRunScope;
  model: AiChatModel;
  signal: AbortSignal;
}

/** true when it compacted (the caller then sends the stored view in place of `runAgent`'s array) */
export async function compactIfNeeded(_input: CompactInput): Promise<boolean> {
  throw new Error('not implemented (L1)');
}
