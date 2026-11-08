/**
 * Assistant tools: credentials (P5-69, lane L5). The model never reads a credential's data: the list
 * answers id, name and type only (names are written by people, so that text is untrusted), the type
 * search is static, and `test_credential` runs the credential's own test on the server and answers the
 * status and a message scrubbed of every stored and resolved value (the same calls as
 * POST /rest/credentials/test). `delete_credential` is editor, needs a card every time (null
 * `grantKey`) and leaves the audit row the REST route leaves.
 */
import type { DataObject } from '@workflow/workflow';
import { z } from 'zod';
import { ApiError } from '../../../http/errors';
import { toWorkflowLogger } from '../../../logger';
import { credentialSummary, deleteCredential } from '../../../routes/credentials';
import { testCredential } from '../../credential-test';
import { credentialReadErrorText, resolvedValues, scrubValues } from '../../secrets/resolver';
import type { AssistantToolDefinition } from '../types';

const fact = (label: string, value: unknown) => ({ label, value: String(value) });

const listInput = z.object({ type: z.string().max(128).optional().describe('Only credentials of this type') });

const listCredentials: AssistantToolDefinition<z.output<typeof listInput>> = {
  name: 'list_credentials',
  description: 'List the credentials of the workspace (id, name and type only; never their data).',
  input: listInput,
  minRole: 'viewer',
  untrusted: 'credentials',
  async handler(ctx, run, input) {
    const rows = await ctx.repos.credentials.list(run.tenant.id, input.type);
    return {
      data: rows.map((row) => {
        const summary = credentialSummary(row);
        return { id: summary.id, name: summary.name, type: summary.type };
      }),
    };
  },
};

const searchTypesInput = z.object({
  query: z.string().trim().min(1).max(128).describe('Part of the credential type name or its display name'),
  limit: z.number().int().min(1).max(50).default(20),
});

const searchCredentialTypes: AssistantToolDefinition<z.output<typeof searchTypesInput>> = {
  name: 'search_credential_types',
  description: 'Find credential types a node can use, by part of the type name or display name.',
  input: searchTypesInput,
  minRole: 'viewer',
  async handler(ctx, _run, input) {
    const needle = input.query.toLowerCase();
    const matches = ctx.registries.credentialTypes
      .list()
      .filter(
        (type) =>
          type.name.toLowerCase().includes(needle) || (type.displayName ?? '').toLowerCase().includes(needle),
      );
    return {
      count: matches.length,
      data: matches.slice(0, input.limit).map((type) => ({ name: type.name, displayName: type.displayName })),
    };
  },
};

const idInput = z.object({ credentialId: z.uuid().describe('The id of the credential') });

const testCredentialTool: AssistantToolDefinition<z.output<typeof idInput>> = {
  name: 'test_credential',
  description:
    "Run a stored credential's own test (a request to the service it belongs to). Answers OK or Error with a message; never its data.",
  input: idInput,
  minRole: 'editor',
  untrusted: 'credential-test',
  async handler(ctx, run, input) {
    const tenantId = run.tenant.id;
    const row = await ctx.repos.credentials.get(tenantId, input.credentialId);
    if (!row) throw ApiError.notFound('Credential');
    const data = ctx.credentials.merge(ctx.credentials.decrypt(row), {});
    ctx.credentials.resolvedType(row.type);
    let resolved: DataObject;
    try {
      resolved = await ctx.credentials.resolveData(tenantId, data);
    } catch (error) {
      return { status: 'Error', message: credentialReadErrorText(error) };
    }
    const result = await testCredential(ctx.credentials, ctx.http, row.type, resolved, {
      nodeTypes: ctx.registries.nodeTypes,
      tenantId,
      logger: toWorkflowLogger(ctx.logger),
    });
    // a client error can quote the URL or header it was given, which may be a vault value
    return { status: result.status, message: scrubValues(result.message, resolvedValues(data, resolved)) };
  },
};

const deleteCredentialTool: AssistantToolDefinition<z.output<typeof idInput>> = {
  name: 'delete_credential',
  description:
    'Delete a credential. Workflows that use it stop working until another is chosen. This cannot be undone, so a person approves it every time.',
  input: idInput,
  minRole: 'editor',
  permission: 'deleteCredential',
  grantKey: () => null,
  async approval(ctx, caller, input) {
    const row = await ctx.repos.credentials.get(caller.tenant.id, input.credentialId);
    if (!row) throw ApiError.notFound('Credential');
    return {
      title: 'Delete a credential',
      resourceName: row.name,
      details: { facts: [fact('Credential', row.name), fact('Type', row.type)] },
    };
  },
  async handler(ctx, run, input) {
    await deleteCredential(
      ctx,
      run.tenant.id,
      input.credentialId,
      run.actor.userId ?? run.user.id,
      run.actor.ip ?? '',
    );
    return { deleted: true, credentialId: input.credentialId };
  },
};

export const credentialsTools: AssistantToolDefinition[] = [
  listCredentials,
  searchCredentialTypes,
  testCredentialTool,
  deleteCredentialTool,
];
