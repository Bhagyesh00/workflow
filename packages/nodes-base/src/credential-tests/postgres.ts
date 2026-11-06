/** Stub of the Postgres credential test; L22 (P4-22) builds it. */
import type { CredentialTestContext, DataObject, NodeCredentialTestResult } from '@workflow/workflow';

export async function postgresCredentialTest(
  _ctx: CredentialTestContext,
  _credential: { type: string; data: DataObject },
): Promise<NodeCredentialTestResult> {
  return { status: 'Error', message: 'Not built yet' };
}
