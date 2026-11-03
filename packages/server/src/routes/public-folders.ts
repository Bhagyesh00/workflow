/**
 * Public API folders (P3-15), as n8n's folders public controller without the project segment:
 * GET/POST /folders, GET/PATCH/DELETE /folders/:folderId (delete query `transferToFolderId`).
 * The rows live in public-api.ts PUBLIC_ROUTES (role gate there); the handlers call the same
 * FolderService as /rest/folders, so the name rule, tenant checks and audit are shared.
 */
import type { ServerContext } from '../context';
import { parse } from '../http/errors';
import {
  folderCreateSchema,
  folderDeleteSchema,
  folderListQuerySchema,
  folderUpdateSchema,
} from '../services/folders';
import type { PublicApiInput } from './public-api';

type Handler = (ctx: ServerContext, input: PublicApiInput) => Promise<unknown>;

const actor = (input: PublicApiInput) => ({ userId: input.auth.user.id, ip: input.request.ip });

export const publicFolderHandlers: Record<'list' | 'create' | 'get' | 'update' | 'remove', Handler> = {
  list: (ctx, input) => ctx.folders.list(input.auth.tenant.id, parse(folderListQuerySchema, input.query)),
  create: async (ctx, input) => ({
    data: await ctx.folders.create(input.auth.tenant.id, parse(folderCreateSchema, input.body), actor(input)),
  }),
  get: async (ctx, input) => ({ data: await ctx.folders.get(input.auth.tenant.id, input.params.folderId) }),
  update: async (ctx, input) => ({
    data: await ctx.folders.update(
      input.auth.tenant.id,
      input.params.folderId,
      parse(folderUpdateSchema, input.body),
      actor(input),
    ),
  }),
  remove: async (ctx, input) => {
    await ctx.folders.delete(
      input.auth.tenant.id,
      input.params.folderId,
      parse(folderDeleteSchema, input.query),
      actor(input),
    );
    return { data: { ok: true } };
  },
};
