/**
 * P6-75 (L5): the projects a caller may push (and read remote content of), as n8n's source-control-scoped service:
 * `'all'` for a caller whose global scopes hold `sourceControl:push`, else the team projects where the caller holds
 * `sourceControl:push` (`ctx.access.accessibleProjectIds`), personal projects never.
 * PASSES (stub (L5)), fail closed: `'all'` for the global scope, else an empty set, so no project admin pushes
 * anything before L5 writes the project rule.
 */
import type { ServiceDeps } from '../../context';
import type { AuthContext } from '../../http/auth';

export async function pushableProjects(deps: ServiceDeps, auth: AuthContext): Promise<'all' | Set<string>> {
  const global = await deps.context().access.scopesForAuth(auth);
  if (global.has('sourceControl:push')) return 'all';
  // stub (L5): the team projects come with L5; until then nothing (fail closed)
  return new Set<string>();
}
