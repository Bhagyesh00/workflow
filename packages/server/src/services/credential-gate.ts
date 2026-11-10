/**
 * P6-87 (L16): the credential gate of a trigger that knows the person (Webhook, Form and Chat with
 * workspace sign-in). `check(userId)` lists the private credentials of the enabled nodes the trigger
 * reaches, sub-nodes included, and is ready when the user has an entry for each; the trigger answers 428
 * with `credentialConnectionsRequiredBody` when not. `forRun` is called for every run that builds services
 * with a definition (services/executions.ts `buildServices`), so it never throws.
 * Stub from C0: `forRun` and `check` PASS (ready, no credentials); `connectPageUrl` throws until L16.
 */
import type { CredentialGateHelper, CredentialGateResult, WorkflowDefinition } from '@workflow/workflow';
import type { ServiceDeps } from '../context';

export class CredentialGateService {
  constructor(readonly deps: ServiceDeps) {}

  forRun(
    _tenantId: string,
    _workflow: WorkflowDefinition,
    _projectId: string,
    _startNode?: string,
  ): CredentialGateHelper {
    return {
      // stub (L16): PASSES, ready with no credential to connect
      check: async (_userId: string): Promise<CredentialGateResult> => ({
        readyToExecute: true,
        credentials: [],
      }),
      connectPageUrl: (_credentialId, _action, _returnTo) => {
        throw new Error('not implemented (L16)');
      },
    };
  }
}
