/**
 * P6-12 (L10): `ldap:reset --tenant <slug>` with exactly one of `--userId`, `--projectId`,
 * `--deleteWorkflowsAndCredentials` (n8n's `ldap:reset`): the work of every LDAP user goes to that user's
 * personal project, to the project, or is deleted (`transferPersonalWork`), then the config and identities
 * are cleared and the method goes back to email. Dispatched by cli.ts, which closes the context after.
 * Nothing changes when the arguments are wrong or the target is not found: all checks run first.
 */
import type { ServerContext } from '../context';
import { assertProjectWorkAllowed, transferPersonalWork } from '../services/member-removal';

export const LDAP_RESET_USAGE =
  'Usage: ldap:reset --tenant <slug> (--userId <id> | --projectId <id> | --deleteWorkflowsAndCredentials)';

interface ResetArgs {
  tenant?: string;
  userId?: string;
  projectId?: string;
  deleteWork: boolean;
}

/** the value of `--name <value>` or `--name=<value>` */
function optionValue(argv: string[], index: number, name: string): string | undefined {
  const arg = argv[index];
  if (arg === `--${name}`) {
    const next = argv[index + 1];
    return next === undefined || next.startsWith('--') ? '' : next;
  }
  if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  return undefined;
}

function parseArgs(argv: string[]): ResetArgs {
  const out: ResetArgs = { deleteWork: false };
  for (let i = 0; i < argv.length; i++) {
    const tenant = optionValue(argv, i, 'tenant');
    const userId = optionValue(argv, i, 'userId');
    const projectId = optionValue(argv, i, 'projectId');
    if (tenant !== undefined) out.tenant = tenant;
    else if (userId !== undefined) out.userId = userId;
    else if (projectId !== undefined) out.projectId = projectId;
    else if (argv[i] === '--deleteWorkflowsAndCredentials') out.deleteWork = true;
    else if (argv[i].startsWith('--'))
      throw new Error(`Unknown option ${argv[i].split('=')[0]}. ${LDAP_RESET_USAGE}`);
  }
  return out;
}

export async function ldapResetCommand(ctx: ServerContext, argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const targets = [args.userId !== undefined, args.projectId !== undefined, args.deleteWork].filter(
    Boolean,
  ).length;
  if (!args.tenant || targets !== 1 || args.userId === '' || args.projectId === '') {
    throw new Error(LDAP_RESET_USAGE);
  }
  const tenant = await ctx.repos.tenants.getBySlug(args.tenant);
  if (!tenant) throw new Error(`No workspace has the slug "${args.tenant}"`);

  // where the work goes: all checks before the first change
  let targetProjectId: string | null = null;
  if (args.userId !== undefined) {
    if (!(await ctx.repos.memberships.getIncludingDisabled(tenant.id, args.userId))) {
      throw new Error('That user is not a member of the workspace');
    }
    const personal = await ctx.repos.projects.getPersonal(tenant.id, args.userId);
    if (!personal) throw new Error('That user has no personal project in the workspace');
    targetProjectId = personal.id;
  } else if (args.projectId !== undefined) {
    const project = await ctx.repos.projects.get(tenant.id, args.projectId);
    if (!project) throw new Error('No such project in the workspace');
    targetProjectId = project.id;
  }

  const identities = await ctx.repos.ldapHistory.identities(tenant.id);
  // the users whose work moves (the --userId user and the target's own owner keep theirs)
  const movers: string[] = [];
  for (const identity of identities) {
    if (args.userId === identity.userId) continue;
    if (targetProjectId !== null) {
      const own = await ctx.repos.projects.getPersonal(tenant.id, identity.userId);
      if (own?.id === targetProjectId) continue;
    }
    movers.push(identity.userId);
  }
  // P6-51: the project's type policies judge every user's work before the first move, so a refusal moves nothing
  if (targetProjectId !== null) {
    for (const userId of movers) {
      const personal = await ctx.repos.projects.getPersonal(tenant.id, userId);
      if (personal) await assertProjectWorkAllowed(ctx.serviceDeps, tenant.id, personal.id, targetProjectId);
    }
  }
  for (const userId of movers) await transferPersonalWork(ctx, tenant.id, userId, targetProjectId);
  await ctx.ldap.reset(tenant.id);
  ctx.logger.info({ users: identities.length }, 'LDAP settings and identities cleared');
}
