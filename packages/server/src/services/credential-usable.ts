/**
 * The pre-run, save and publish credential check (P6-24): every credential a workflow's nodes name must be
 * usable by the workflow's project (owned by it, shared with it, global, or in `allow`, which comes from
 * server paths only, never from a node or a body). C0 wires the call sites (C0d); this stub lets every
 * credential pass until L4 fills it. Error texts are n8n's (credentials-permission-checker.ts).
 */
import type { WorkflowDefinition } from '@workflow/workflow';
import { ApiError } from '../http/errors';
import type { Repositories } from '../repositories';

/** what the check reads (a `ServiceDeps` or any object with the repositories fits) */
export interface CredentialUsableDeps {
  repos: Repositories;
}

/** a node names a credential with no id, or one that does not exist (n8n's text) */
export class InvalidCredentialError extends ApiError {
  readonly description = 'Please recreate the credential.';

  constructor(readonly nodeName: string) {
    super(400, 'invalid_credential', `Node "${nodeName}" uses invalid credential`, {
      description: 'Please recreate the credential.',
    });
    this.name = 'InvalidCredentialError';
  }
}

/** a node names a credential the workflow's project cannot use (n8n's text) */
export class InaccessibleCredentialError extends ApiError {
  readonly description: string;

  constructor(
    readonly nodeName: string,
    project?: { type: 'personal' | 'team'; name: string },
  ) {
    const description =
      project?.type === 'team'
        ? `Please make sure that the credential is shared with the project "${project.name}"`
        : 'Please recreate the credential or ask its owner to share it with you.';
    super(400, 'inaccessible_credential', `Node "${nodeName}" does not have access to the credential`, {
      description,
    });
    this.description = description;
    this.name = 'InaccessibleCredentialError';
  }
}

/**
 * Throws `InvalidCredentialError` or `InaccessibleCredentialError` for the first node whose credential the
 * project cannot use. Stub (L4): passes everything in C0.
 */
export async function assertCredentialsUsable(
  deps: CredentialUsableDeps,
  tenantId: string,
  projectId: string,
  definition: WorkflowDefinition,
  options?: { allow?: string[] },
): Promise<void> {
  // stub (L4): every credential passes until L4 fills the check
  void deps;
  void tenantId;
  void projectId;
  void definition;
  void options;
}
