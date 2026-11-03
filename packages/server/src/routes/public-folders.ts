/**
 * Public API folders (P3-15), as n8n's folders public controller without the project segment:
 * GET/POST /folders, GET/PATCH/DELETE /folders/:folderId (delete query `transferToFolderId`).
 * The rows live in public-api.ts PUBLIC_ROUTES; their handlers call these.
 *
 * C0 STUB: lane L16 writes the bodies (each throws 501).
 */
import type { ServerContext } from '../context';
import { ApiError } from '../http/errors';
import type { PublicApiInput } from './public-api';

type Handler = (ctx: ServerContext, input: PublicApiInput) => Promise<unknown>;

const notImplemented: Handler = async () => {
  throw new ApiError(501, 'not_implemented', 'not implemented (L16)');
};

export const publicFolderHandlers: Record<'list' | 'create' | 'get' | 'update' | 'remove', Handler> = {
  list: notImplemented,
  create: notImplemented,
  get: notImplemented,
  update: notImplemented,
  remove: notImplemented,
};
