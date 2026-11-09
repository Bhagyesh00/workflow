/**
 * Transfers (P6-30, L9): GET .../transfer-preview and PUT .../transfer for workflows, credentials and
 * folders, as n8n (`<resource>:move` on the row; the destination's `:create` is the service's). C0
 * registers the six routes with their final path and gate; the handlers reach `ctx.transfer`, a stub
 * that throws until L9.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';
import { parse } from '../http/errors';

const idParams = z.object({ id: z.string() });
const previewQuery = z.object({ destinationProjectId: z.uuid() });
const ids = z.array(z.uuid()).max(1000);
const workflowBody = z.object({
  destinationProjectId: z.uuid(),
  shareCredentials: ids.optional(),
  destinationParentFolderId: z.uuid().optional(),
});
const credentialBody = z.object({ destinationProjectId: z.uuid() });
const folderBody = z.object({
  destinationProjectId: z.uuid(),
  destinationParentFolderId: z.uuid().optional(),
  shareCredentials: ids.optional(),
});

export function registerTransferRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { transfer } = ctx;

  app.get('/workflows/:id/transfer-preview', async (request) => {
    const { id } = parse(idParams, request.params);
    const auth = await requireScope(request, 'workflow:move', { workflowId: id });
    const query = parse(previewQuery, request.query ?? {});
    return { data: await transfer.previewWorkflow(auth, id, query.destinationProjectId) };
  });

  app.put('/workflows/:id/transfer', async (request) => {
    const { id } = parse(idParams, request.params);
    const auth = await requireScope(request, 'workflow:move', { workflowId: id });
    await transfer.transferWorkflow(auth, id, parse(workflowBody, request.body));
    return { data: { ok: true } };
  });

  app.get('/credentials/:id/transfer-preview', async (request) => {
    const { id } = parse(idParams, request.params);
    const auth = await requireScope(request, 'credential:move', { credentialId: id });
    const query = parse(previewQuery, request.query ?? {});
    return { data: await transfer.previewCredential(auth, id, query.destinationProjectId) };
  });

  app.put('/credentials/:id/transfer', async (request) => {
    const { id } = parse(idParams, request.params);
    const auth = await requireScope(request, 'credential:move', { credentialId: id });
    await transfer.transferCredential(auth, id, parse(credentialBody, request.body));
    return { data: { ok: true } };
  });

  app.get('/folders/:id/transfer-preview', async (request) => {
    const { id } = parse(idParams, request.params);
    const auth = await requireScope(request, 'folder:move', { folderId: id });
    const query = parse(previewQuery, request.query ?? {});
    return { data: await transfer.previewFolder(auth, id, query.destinationProjectId) };
  });

  app.put('/folders/:id/transfer', async (request) => {
    const { id } = parse(idParams, request.params);
    const auth = await requireScope(request, 'folder:move', { folderId: id });
    await transfer.transferFolder(auth, id, parse(folderBody, request.body));
    return { data: { ok: true } };
  });
}
