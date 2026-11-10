/**
 * P6-12 (L10): `ldap:reset --tenant <slug>` with exactly one of `--userId`, `--projectId`,
 * `--deleteWorkflowsAndCredentials` (n8n's `ldap:reset`): the work of every LDAP user goes to that user's
 * personal project, to the project, or is deleted (`transferPersonalWork`), then the config and identities
 * are cleared and the method goes back to email. Dispatched by cli.ts. Stub from C0: throws until L10.
 */
import type { ServerContext } from '../context';

export async function ldapResetCommand(_ctx: ServerContext, _argv: string[]): Promise<void> {
  throw new Error('not implemented (L10)');
}
