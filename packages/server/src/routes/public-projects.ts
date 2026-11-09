/**
 * Public API projects (P6-34), n8n's projects public controller: `/projects` (list, create, update,
 * delete), `/projects/:projectId/users` (list, add, change role, remove) and the two transfers,
 * PUT `/workflows/:id/transfer` and PUT `/credentials/:id/transfer`. PUBLIC_PROJECT_ROUTES is final and
 * shaped as PUBLIC_DATA_TABLE_ROUTES (public-api.ts spreads it and runs the `access` check, then the key
 * scope). The handlers call the services of the REST routes (`ctx.projects`, `ctx.transfer`), which check
 * the user's scope again on the row: a key sees and changes only what its user may.
 */
import { z } from 'zod';
import type { ServerContext } from '../context';
import { ApiError } from '../http/errors';
import { MISSING_SCOPE_MESSAGE } from '../services/access';
import type { ProjectDetailDTO, ProjectListRow } from '../services/projects';
import { projectPatchBody } from './projects';
import type { ApiRoute, PublicApiInput, RouteTarget } from './public-api';
import { decodeCursor, paged } from './public-data-tables';

type Handler = (ctx: ServerContext, input: PublicApiInput) => Promise<unknown>;

const projectParams = z.object({ projectId: z.uuid() });
const userParams = projectParams.extend({ userId: z.uuid() });
const idParams = z.object({ id: z.uuid() });

const icon = z.object({ type: z.enum(['icon', 'emoji']), value: z.string().min(1).max(64) });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  cursor: z.string().max(512).optional(),
});
const createBody = z.object({
  name: z.string().trim().min(1).max(255),
  icon: icon.nullable().optional(),
  description: z.string().max(512).nullable().optional(),
});
const relation = z.object({ userId: z.uuid(), role: z.string().min(1).max(128) });
const addUsersBody = z.object({ relations: z.array(relation).min(1).max(1000) });
const roleBody = z.object({ role: z.string().min(1).max(128) });
const deleteQuery = z.object({ transferId: z.uuid().optional() });
const ids = z.array(z.uuid()).max(1000);
const workflowTransferBody = z.object({
  destinationProjectId: z.uuid(),
  shareCredentials: ids.optional(),
  destinationParentFolderId: z.uuid().optional(),
});
const credentialTransferBody = z.object({ destinationProjectId: z.uuid() });

/** a project as the public API answers it */
const projectDTO = (project: ProjectListRow | ProjectDetailDTO) => ({
  id: project.id,
  name: project.name,
  type: project.type,
  icon: project.icon,
  description: project.description,
  ...(project.role === undefined ? {} : { role: project.role }),
  scopes: project.scopes,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});

export const publicProjectHandlers: Record<
  | 'list'
  | 'create'
  | 'update'
  | 'remove'
  | 'listUsers'
  | 'addUsers'
  | 'changeUserRole'
  | 'removeUser'
  | 'transferWorkflow'
  | 'transferCredential',
  Handler
> = {
  list: async (ctx, { auth, query }) => {
    const skip = decodeCursor(query.cursor);
    const result = await ctx.projects.list(auth, { take: query.limit, skip });
    // a paged call answers { count, data }
    const page = Array.isArray(result) ? { count: result.length, data: result } : result;
    return paged(page, skip, projectDTO);
  },
  create: async (ctx, { auth, body }) => ({ data: projectDTO(await ctx.projects.create(auth, body)) }),
  update: async (ctx, { auth, params, body }) => ({
    data: projectDTO(await ctx.projects.update(auth, params.projectId, body)),
  }),
  remove: async (ctx, { auth, params, query }) => {
    await ctx.projects.delete(auth, params.projectId, query);
    return { data: { ok: true } };
  },
  listUsers: async (ctx, { auth, params }) => {
    // user:list is every member's; the members of a project are for those who can read the project
    const held = await ctx.access.scopesForAuth(auth, { projectId: params.projectId });
    if (!held.has('project:read')) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
    const project = await ctx.projects.get(auth, params.projectId);
    return {
      data: project.relations.map((r) => ({ userId: r.id, email: r.email, name: r.name, role: r.role })),
      nextCursor: null,
    };
  },
  addUsers: async (ctx, { auth, params, body }) => {
    const { added, conflicts } = await ctx.projects.addUsers(auth, params.projectId, body.relations);
    if (added === 0 && conflicts.length > 0) {
      throw ApiError.conflict('No users were added: they are already members of this project', { conflicts });
    }
    return { data: { conflicts } };
  },
  changeUserRole: async (ctx, { auth, params, body }) => {
    await ctx.projects.changeUserRole(auth, params.projectId, params.userId, body.role);
    return { data: { ok: true } };
  },
  removeUser: async (ctx, { auth, params }) => {
    await ctx.projects.removeUser(auth, params.projectId, params.userId);
    return { data: { ok: true } };
  },
  transferWorkflow: async (ctx, { auth, params, body }) => {
    await ctx.transfer.transferWorkflow(auth, params.id, body);
    return { data: { ok: true } };
  },
  transferCredential: async (ctx, { auth, params, body }) => {
    await ctx.transfer.transferCredential(auth, params.id, body);
    return { data: { ok: true } };
  },
};

const onProject: RouteTarget = ({ params }) => ({ projectId: params.projectId });

const row = (name: keyof typeof publicProjectHandlers, fields: Omit<ApiRoute, 'handler'>): ApiRoute => ({
  ...fields,
  /** late bound, so the handler that runs is the one in the table above */
  handler: (ctx, input) => publicProjectHandlers[name](ctx, input),
});

const users = '/projects/:projectId/users';

export const PUBLIC_PROJECT_ROUTES: ApiRoute[] = [
  row('list', {
    method: 'GET',
    path: '/projects',
    summary: 'List the projects the key’s user can see',
    tag: 'Projects',
    // no scope on the route (as the REST list): the service narrows the rows to the caller's projects
    access: { scope: 'project:list', list: true },
    scope: 'project:list',
    query: listQuery,
    response: 'Project',
    list: true,
  }),
  row('create', {
    method: 'POST',
    path: '/projects',
    summary: 'Create a team project (the key’s user becomes its admin)',
    tag: 'Projects',
    access: { scope: 'project:create' },
    scope: 'project:create',
    body: createBody,
    response: 'Project',
    status: 201,
  }),
  row('update', {
    method: 'PUT',
    path: '/projects/:projectId',
    summary: 'Update a project (name, icon, description)',
    tag: 'Projects',
    access: { scope: 'project:update', target: onProject },
    scope: 'project:update',
    params: projectParams,
    body: projectPatchBody,
    response: 'Project',
  }),
  row('remove', {
    method: 'DELETE',
    path: '/projects/:projectId',
    summary: 'Delete a project (transferId moves its work to another project, else the work is deleted)',
    tag: 'Projects',
    access: { scope: 'project:delete', target: onProject },
    scope: 'project:delete',
    params: projectParams,
    query: deleteQuery,
    response: 'Ok',
  }),
  row('listUsers', {
    method: 'GET',
    path: users,
    summary: 'List the members of a project',
    tag: 'Projects',
    access: { scope: 'user:list', target: onProject },
    scope: 'user:list',
    params: projectParams,
    response: 'ProjectUser',
    list: true,
  }),
  row('addUsers', {
    method: 'POST',
    path: users,
    summary: 'Add members to a project (a user who already has another role is a conflict)',
    tag: 'Projects',
    access: { scope: 'project:manageMembers', target: onProject },
    scope: 'project:manageMembers',
    params: projectParams,
    body: addUsersBody,
    response: 'ProjectUsersResult',
    status: 201,
  }),
  row('changeUserRole', {
    method: 'PATCH',
    path: `${users}/:userId`,
    summary: 'Change the role of a member of a project',
    tag: 'Projects',
    access: { scope: 'project:manageMembers', target: onProject },
    scope: 'project:manageMembers',
    params: userParams,
    body: roleBody,
    response: 'Ok',
  }),
  row('removeUser', {
    method: 'DELETE',
    path: `${users}/:userId`,
    summary: 'Remove a member from a project',
    tag: 'Projects',
    access: { scope: 'project:manageMembers', target: onProject },
    scope: 'project:manageMembers',
    params: userParams,
    response: 'Ok',
  }),
  row('transferWorkflow', {
    method: 'PUT',
    path: '/workflows/:id/transfer',
    summary: 'Move a workflow to another project (it is unpublished when the destination cannot run it)',
    tag: 'Workflows',
    access: { scope: 'workflow:move', target: ({ params }) => ({ workflowId: params.id }) },
    scope: 'workflow:move',
    params: idParams,
    body: workflowTransferBody,
    response: 'Ok',
  }),
  row('transferCredential', {
    method: 'PUT',
    path: '/credentials/:id/transfer',
    summary: 'Move a credential to another project',
    tag: 'Credentials',
    access: { scope: 'credential:move', target: ({ params }) => ({ credentialId: params.id }) },
    scope: 'credential:move',
    params: idParams,
    body: credentialTransferBody,
    response: 'Ok',
  }),
];
