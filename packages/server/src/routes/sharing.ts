/**
 * /rest/workflows/:id/share and /rest/credentials/:id/share (P6-29, L9). C0 registers both with their
 * final path and gate (`<resource>:share` or `<resource>:unshare` on the row, any one; the service checks
 * which the change needs); the handlers reach `ctx.sharing`, a stub that throws until L9.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';
import { parse } from '../http/errors';

const idParams = z.object({ id: z.string() });
const shareBody = z.object({ shareWithIds: z.array(z.uuid()).max(1000) });

export function registerSharingRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { sharing } = ctx;

  app.put('/workflows/:id/share', async (request) => {
    const { id } = parse(idParams, request.params);
    const auth = await requireScope(request, ['workflow:share', 'workflow:unshare'], { workflowId: id });
    await sharing.shareWorkflow(auth, id, parse(shareBody, request.body).shareWithIds);
    return { data: { ok: true } };
  });

  app.put('/credentials/:id/share', async (request) => {
    const { id } = parse(idParams, request.params);
    const auth = await requireScope(request, ['credential:share', 'credential:unshare'], {
      credentialId: id,
    });
    await sharing.shareCredential(auth, id, parse(shareBody, request.body).shareWithIds);
    return { data: { ok: true } };
  });
}
