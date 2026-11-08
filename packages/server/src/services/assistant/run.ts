/**
 * One Assistant turn (P5-67, lane L1): the run scope, the recording model and tool wrappers, `runAgent`
 * from `loadAiRuntime`, stop on a pending card and resume from the stored history. C0 stub with the final
 * signature of `createRunScope`; L1 adds the turn itself here.
 */
import type { ServerContext } from '../../context';
import type { Actor } from '../workflows';
import type { AssistantRunScope, StoredAttachment } from './types';

export interface CreateRunScopeInput {
  tenantId: string;
  userId: string;
  threadId: string;
  runId: string;
  actor: Actor;
  signal: AbortSignal;
  attachments: StoredAttachment[];
}

/**
 * The scope of one turn, first or resumed: tenant, user and role read now, the effective settings,
 * `sendValues`, the turn's attachments and `emit` bound to this thread and run.
 */
export async function createRunScope(
  _ctx: ServerContext,
  _input: CreateRunScopeInput,
): Promise<AssistantRunScope> {
  throw new Error('not implemented (L1)');
}
