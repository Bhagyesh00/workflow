/**
 * Approvals (P5-68, lane L3): the gate before every gated call, the person's answer, the run of an
 * approved call and the card timeout. C0 stub with the final signatures: `gate` refuses a definition with
 * `permission` or `suspendFor` and proceeds otherwise, so nothing throws before L3; `sweepExpired` does
 * nothing; `confirm` and `runApproved` throw `not implemented (L3)`. Built with the same `extraTools` as
 * the service, so an approved test tool is found again.
 */
import type { AssistantConfirmAnswer } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { AuthContext } from '../../http/auth';
import type { AssistantConfirmationRow } from '../../repositories/assistant-confirmations';
import type { Actor } from '../workflows';
import type { AssistantRunScope, AssistantToolDefinition, GateResult } from './types';

/** the texts the model reads in place of a gated call's result */
export const ASSISTANT_APPROVAL_TEXTS = {
  waiting: "Waiting for the person's approval",
  refused: 'The person refused this',
  timedOut: 'The approval timed out, so this did not run',
  runStopped: 'The run stopped before this ran',
  blocked: 'An admin turned this off',
} as const;

/** C0's refusal for a gated call before L3 exists */
const NO_APPROVALS_YET = 'This needs a person to approve it, and approvals are not available yet';

export class AssistantApprovals {
  constructor(
    readonly deps: ServiceDeps,
    readonly extraTools: AssistantToolDefinition[] = [],
  ) {}

  /** in order: blocked, always allow, thread grant, `suspendFor`, else an approval card */
  async gate(
    _run: AssistantRunScope,
    def: AssistantToolDefinition,
    _input: unknown,
    _toolCallId: string,
  ): Promise<GateResult> {
    if (def.permission !== undefined || def.suspendFor !== undefined) {
      return { decision: 'refuse', reason: NO_APPROVALS_YET };
    }
    return { decision: 'proceed' };
  }

  /** the person's answer; claims the row atomically (tenant, user, id), then settles the turn */
  async confirm(
    _auth: AuthContext,
    _requestId: string,
    _answer: AssistantConfirmAnswer,
    _actor?: Actor,
  ): Promise<{ ok: true }> {
    throw new Error('not implemented (L3)');
  }

  /** runs one approved call with its stored args (`resume` or `handler`), under the settle's run lock */
  async runApproved(_run: AssistantRunScope, _row: AssistantConfirmationRow): Promise<void> {
    throw new Error('not implemented (L3)');
  }

  /** cards past `expires_at` (and, with no thread, orphan approved ones) expire; C0: does nothing */
  async sweepExpired(_now: Date, _threadId?: string): Promise<void> {}
}
