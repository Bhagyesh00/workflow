/**
 * /rest/source-control (P6-73, L2), as n8n's source control preferences controller: GET preferences (any signed-in
 * user; the answer narrows by scope), POST and PATCH preferences, POST disconnect, GET get-branches and POST
 * generate-key-pair (`sourceControl:manage`). The key and the token never appear in an answer.
 * Every route but GET preferences needs `sourceControl:manage`; a branch name starts with a letter or a digit and
 * the colour is `#rrggbb` (a 400 before the service runs).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireAuth, requireScope } from '../http/auth';
import { parse } from '../http/errors';

const keyType = z.enum(['ed25519', 'rsa']);

/** n8n's preferences body; every field optional (POST connects, PATCH changes branch, colour and read-only) */
export const sourceControlPreferencesSchema = z.object({
  repositoryUrl: z.string().trim().min(1).max(2048).optional(),
  connectionType: z.enum(['ssh', 'https']).optional(),
  branchName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/, 'The branch name must start with a letter or a digit')
    .optional(),
  branchReadOnly: z.boolean().optional(),
  branchColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'The branch colour must look like #5296D6')
    .optional(),
  initRepo: z.boolean().optional(),
  keyGeneratorType: keyType.optional(),
  httpsUsername: z.string().max(255).optional(),
  httpsPassword: z.string().max(4096).optional(),
});

export const sourceControlDisconnectSchema = z.object({ keepKeyPair: z.boolean().optional() });

export const generateKeyPairSchema = z.object({ keyGeneratorType: keyType.optional() });

export function registerSourceControlRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // requireAuth on purpose: every signed-in user reads it and the service narrows the answer by scope (n8n: the
  // full answer for `sourceControl:manage`, connected and branch for a user with pushable projects, else only
  // `branchReadOnly`)
  app.get('/source-control/preferences', async (request) => {
    const auth = requireAuth(request);
    return { data: await ctx.sourceControl.preferencesFor(auth) };
  });

  app.post('/source-control/preferences', async (request) => {
    const auth = await requireScope(request, 'sourceControl:manage');
    const body = parse(sourceControlPreferencesSchema, request.body ?? {});
    return { data: await ctx.sourceControl.connect(auth, body) };
  });

  app.patch('/source-control/preferences', async (request) => {
    const auth = await requireScope(request, 'sourceControl:manage');
    const body = parse(sourceControlPreferencesSchema, request.body ?? {});
    return { data: await ctx.sourceControl.patch(auth, body) };
  });

  app.post('/source-control/disconnect', async (request) => {
    const auth = await requireScope(request, 'sourceControl:manage');
    const body = parse(sourceControlDisconnectSchema, request.body ?? {});
    return { data: await ctx.sourceControl.disconnect(auth, body) };
  });

  app.get('/source-control/get-branches', async (request) => {
    const auth = await requireScope(request, 'sourceControl:manage');
    return { data: await ctx.sourceControl.listBranches(auth) };
  });

  app.post('/source-control/generate-key-pair', async (request) => {
    const auth = await requireScope(request, 'sourceControl:manage');
    const body = parse(generateKeyPairSchema, request.body ?? {});
    return { data: await ctx.sourceControl.generateKeyPair(auth, body.keyGeneratorType) };
  });
}
