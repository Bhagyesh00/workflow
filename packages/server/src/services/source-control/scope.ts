/**
 * P6-75 (L5): the projects a caller may push (and read remote content of), as n8n's source-control-scoped service:
 * `'all'` for a caller whose global scopes hold `sourceControl:push`, else the team projects where the caller holds
 * `sourceControl:push` (`ctx.access.accessibleProjectIds`, so a role change or a removal takes effect on the next
 * call), personal projects never. The set is read on every call and never cached across requests.
 */
import type { ServiceDeps } from '../../context';
import type { AuthContext } from '../../http/auth';

export async function pushableProjects(deps: ServiceDeps, auth: AuthContext): Promise<'all' | Set<string>> {
  const context = deps.context();
  const global = await context.access.scopesForAuth(auth);
  if (global.has('sourceControl:push')) return 'all';
  const ids = await context.access.accessibleProjectIds(auth, 'sourceControl:push');
  const team = new Set<string>();
  for (const id of ids) {
    const project = await deps.repos.projects.get(auth.tenant.id, id);
    if (project?.type === 'team') team.add(project.id);
  }
  return team;
}
