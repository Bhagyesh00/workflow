/**
 * Node module resolution hook for running TypeScript sources with tsx.
 *
 * Node packages use extensionless relative imports such as `./nodes/core/Webhook.node`. The
 * `.node` suffix looks like a file extension (native addons), so it is not completed to
 * `.node.ts`. This hook retries such specifiers with `.ts` appended. Load it after tsx:
 *   node --no-node-snapshot --import tsx --import ./src/register-hooks.mjs src/cli.ts
 */
import { register } from 'node:module';

register(
  `data:text/javascript,${encodeURIComponent(`
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && /\\.[A-Za-z0-9]+$/.test(specifier) && !/\\.(m|c)?[jt]sx?$|\\.json$/.test(specifier) && context.parentURL?.startsWith('file:')) {
    const candidate = new URL(specifier + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
  }
  return next(specifier, context);
}
`)}`,
);
