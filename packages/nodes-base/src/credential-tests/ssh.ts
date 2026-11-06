/** Stub of the SSH (sshPassword and sshPrivateKey) credential test; L22 (P4-22) builds it. */
import type { CredentialTestContext, DataObject, NodeCredentialTestResult } from '@workflow/workflow';

export async function sshCredentialTest(
  _ctx: CredentialTestContext,
  _credential: { type: string; data: DataObject },
): Promise<NodeCredentialTestResult> {
  return { status: 'Error', message: 'Not built yet' };
}
