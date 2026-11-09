/**
 * Moves between projects (P6-30, L9): previews and transfers of a workflow, a credential and a folder
 * (its whole tree). Needs `<resource>:move` on the source (the route's gate) and `<resource>:create` on
 * the destination (checked here). Steps: unpublish if active, drop all shares, set `project_id`, share the
 * chosen credentials into the destination, set the folder, try to republish (a refused republish leaves it
 * unpublished). A credential's destination must reach every vault its data names
 * (`SecretsManager.assertProjectAccess`, L8). No data table move (n8n has none). C0 stub: the constructor
 * is real, every method throws until L9.
 */
import type { ServiceDeps } from '../context';
import type { AuthContext } from '../http/auth';

const notImplemented = (): never => {
  throw new Error('not implemented (L9)');
};

/** PUT /workflows/:id/transfer */
export interface WorkflowTransferInput {
  destinationProjectId: string;
  /** credential ids the move shares into the destination */
  shareCredentials?: string[];
  destinationParentFolderId?: string;
}

/** PUT /credentials/:id/transfer */
export interface CredentialTransferInput {
  destinationProjectId: string;
}

/** PUT /folders/:id/transfer (the whole tree) */
export interface FolderTransferInput {
  destinationProjectId: string;
  destinationParentFolderId?: string;
  shareCredentials?: string[];
}

export class TransferService {
  constructor(readonly deps: ServiceDeps) {}

  async previewWorkflow(
    _auth: AuthContext,
    _workflowId: string,
    _destinationProjectId: string,
  ): Promise<unknown> {
    return notImplemented();
  }

  async previewCredential(
    _auth: AuthContext,
    _credentialId: string,
    _destinationProjectId: string,
  ): Promise<unknown> {
    return notImplemented();
  }

  async previewFolder(
    _auth: AuthContext,
    _folderId: string,
    _destinationProjectId: string,
  ): Promise<unknown> {
    return notImplemented();
  }

  async transferWorkflow(
    _auth: AuthContext,
    _workflowId: string,
    _input: WorkflowTransferInput,
  ): Promise<void> {
    notImplemented();
  }

  async transferCredential(
    _auth: AuthContext,
    _credentialId: string,
    _input: CredentialTransferInput,
  ): Promise<void> {
    notImplemented();
  }

  async transferFolder(_auth: AuthContext, _folderId: string, _input: FolderTransferInput): Promise<void> {
    notImplemented();
  }
}
