/**
 * Form user auth (P4-16, n8n "n8n User Auth"): a one-time code from the signed-in session, swapped by
 * the form for a 60 minute token. Stub until L2.
 */
import type { FormAuthHelper, FormUser } from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import { ApiError } from '../http/errors';

const notBuilt = () => new ApiError(501, 'not_built', 'not built');

export class FormAuthService implements FormAuthHelper {
  constructor(readonly deps: ServiceDeps) {}

  /** where a signed-out visitor goes */
  signInUrl(_returnTo: string): string {
    throw notBuilt();
  }

  /** the token for a code, null for a used or expired code */
  async exchangeCode(_code: string): Promise<string | null> {
    throw notBuilt();
  }

  async verifyToken(_token: string): Promise<FormUser | null> {
    throw notBuilt();
  }

  /** editor or above in the workflow's tenant */
  async canExecute(_userId: string, _workflowId: string): Promise<boolean> {
    throw notBuilt();
  }

  /** a one-time code, good for 60 seconds, for the signed-in user */
  async issueCode(_userId: string, _returnTo: string): Promise<string> {
    throw notBuilt();
  }
}
