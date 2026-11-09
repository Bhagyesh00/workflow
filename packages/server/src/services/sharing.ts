/**
 * Sharing (P6-29, L9): PUT /workflows/:id/share and /credentials/:id/share with `shareWithIds`, the full
 * list of sharee project ids. Adding needs `<resource>:share`, removing `<resource>:unshare`; new shares
 * get `workflow:editor` and `credential:user` (`repos.shares`). C0 stub: the constructor is real, every
 * method throws until L9.
 */
import type { ServiceDeps } from '../context';
import type { AuthContext } from '../http/auth';

const notImplemented = (): never => {
  throw new Error('not implemented (L9)');
};

export class SharingService {
  constructor(readonly deps: ServiceDeps) {}

  async shareWorkflow(_auth: AuthContext, _workflowId: string, _shareWithIds: string[]): Promise<void> {
    notImplemented();
  }

  async shareCredential(_auth: AuthContext, _credentialId: string, _shareWithIds: string[]): Promise<void> {
    notImplemented();
  }
}
