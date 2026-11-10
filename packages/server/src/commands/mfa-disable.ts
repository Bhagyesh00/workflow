/**
 * P6-18 (L2): `mfa:disable --email <address>` turns a user's MFA off (n8n's `mfa:disable`), for a person
 * locked out of their authenticator. Dispatched by cli.ts. Stub from C0: throws until L2.
 */
import type { ServerContext } from '../context';

export async function mfaDisableCommand(_ctx: ServerContext, _argv: string[]): Promise<void> {
  throw new Error('not implemented (L2)');
}
