/**
 * P6-18 (L2): `mfa:disable --email <address>` turns a user's MFA off, for a person locked out of their
 * authenticator. Dispatched by cli.ts, which closes the context after the command.
 */
import type { ServerContext } from '../context';

export const MFA_DISABLE_USAGE = 'Usage: mfa:disable --email <address>';

/** the address after `--email` (or `--email=<address>`), or undefined */
function emailOf(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--email') return argv[i + 1];
    if (arg.startsWith('--email=')) return arg.slice('--email='.length);
  }
  return undefined;
}

export async function mfaDisableCommand(ctx: ServerContext, argv: string[]): Promise<void> {
  const email = emailOf(argv)?.trim();
  if (!email || email.startsWith('--')) throw new Error(MFA_DISABLE_USAGE);
  const cleared = await ctx.mfa.disableByEmail(email);
  ctx.logger.info(
    { cleared },
    cleared ? 'Two-factor sign-in turned off' : 'No two-factor sign-in was set for that address',
  );
}
