/** Demo data: one workspace, its owner and a sample workflow (Manual Trigger -> Edit Fields). */
import { randomBytes, randomUUID } from 'node:crypto';
import type { ServerContext } from './context';
import { sha256 } from './services/auth';

export interface SeedResult {
  created: boolean;
  email: string;
  password?: string;
  tenantSlug: string;
  workflowId?: string;
}

export async function seed(
  ctx: ServerContext,
  options: { email?: string; password?: string; workspaceName?: string } = {},
): Promise<SeedResult> {
  const email = (options.email ?? 'demo@example.com').toLowerCase();
  const existing = await ctx.repos.users.getByEmail(email);
  if (existing) {
    const tenants = await ctx.repos.memberships.listForUser(existing.id);
    return { created: false, email, tenantSlug: tenants[0]?.slug ?? '' };
  }
  const password = options.password ?? `Demo-${randomBytes(6).toString('base64url')}1`;
  // seeding works even when public sign-up is disabled
  const result = await ctx.auth.signup(
    { email, password, name: 'Demo Owner', workspaceName: options.workspaceName ?? 'Demo' },
    { ip: '127.0.0.1', userAgent: 'seed' },
    { ignoreSignupSetting: true },
  );
  await ctx.repos.sessions.delete(sha256(result.token));
  // P6-39: the sample workflow goes to the owner's personal project (signup made it)
  const personal = await ctx.repos.projects.ensurePersonal(result.tenant.id, result.user);

  const trigger = 'When clicking ‘Execute workflow’';
  const workflow = await ctx.workflows.create(
    result.tenant.id,
    {
      name: 'Hello world',
      nodes: [
        {
          id: randomUUID(),
          name: trigger,
          type: 'core.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          id: randomUUID(),
          name: 'Edit Fields',
          type: 'core.set',
          typeVersion: 1,
          position: [260, 0],
          parameters: {
            mode: 'manual',
            assignments: {
              assignments: [
                { id: randomUUID(), name: 'message', value: 'Hello from the demo workspace', type: 'string' },
                { id: randomUUID(), name: 'createdAt', value: '={{ $now.toISO() }}', type: 'string' },
              ],
            },
          },
        },
      ],
      connections: { [trigger]: { main: [[{ node: 'Edit Fields', type: 'main', index: 0 }]] } },
      settings: {},
      projectId: personal.id,
    },
    { userId: result.user.id },
  );
  return { created: true, email, password, tenantSlug: result.tenant.slug, workflowId: workflow.id };
}
