/**
 * P6-78 (L11): `import:workflow`. Dispatched by cli.ts inside `createContext`, the context closed after it; the
 * result is the exit code (0 ok), which cli.ts sets as `process.exitCode`. Output goes through `io` (default
 * `processIo()`), so tests capture it.
 * - import:workflow: `--tenant <slug> --input <path>`, `--separate` (the input is a folder of files), `--projectId`
 * A file holds one workflow or a list. An id that is already a workflow of this workspace is kept (the workflow
 * is updated); any other gets a new id, and a reference to an imported workflow (a sub-workflow node, an error
 * workflow) is rewritten through a local map by `rewriteUuids`, so another workspace's id never reaches the
 * database or the output. Each file goes through the `contentImport` policy (a violation refuses that file and
 * the exit is 1) and then through `WorkflowService`, which runs the save policy, the deprecated node check and
 * the protected lock. A folder, tag or credential of the file is not imported: it holds none of them.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ServerContext } from '../context';
import { workflowCreateSchema } from '../http/schemas';
import { rewriteUuids } from '../services/rewrite-uuids';
import { evaluateWorkflow } from '../services/type-policies/enforce';
import { PolicyViolationError } from '../services/type-policies/errors';
import {
  CommandUsageError,
  commandActor,
  errorText,
  importProject,
  parseCommandArgs,
  requireTenant,
  runCommand,
} from './command-args';
import type { CommandIo } from './command-io';

export const IMPORT_WORKFLOW_USAGE =
  'Usage: import:workflow --tenant <slug> --input <path> [--separate] [--projectId <id>]';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Content = Omit<ReturnType<typeof workflowCreateSchema.parse>, 'folderId' | 'tagIds'>;

interface Imported {
  label: string;
  id: string;
  versionId: string;
  content: Content;
}

/** the workflows of the input: a file with one or a list, or with `--separate` every `.json` file of a folder */
async function readInput(io: CommandIo, input: string, separate: boolean): Promise<unknown[]> {
  const files = separate
    ? (await readdir(input))
        .filter((name) => name.toLowerCase().endsWith('.json'))
        .sort()
        .map((name) => path.join(input, name))
    : [input];
  const items: unknown[] = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await io.readFile(file));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`${path.basename(file)} is not valid JSON`);
      throw error;
    }
    items.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  return items;
}

/** a refused file's text: the message, and the types a policy blocked */
function refusal(error: unknown): string {
  if (error instanceof PolicyViolationError && error.violations.length > 0) {
    const types = [...new Set(error.violations.map((violation) => violation.type))];
    return `${errorText(error)} (blocked: ${types.join(', ')})`;
  }
  return errorText(error);
}

export function importWorkflowCommand(ctx: ServerContext, argv: string[], io?: CommandIo): Promise<number> {
  return runCommand(io, IMPORT_WORKFLOW_USAGE, async (out) => {
    const args = parseCommandArgs(argv, { values: ['tenant', 'input', 'projectId'], flags: ['separate'] });
    const tenant = await requireTenant(ctx, args);
    const input = args.value('input');
    if (input === undefined) throw new CommandUsageError('--input <path> is required');
    const actor = await commandActor(ctx, tenant.id);
    // the project is checked before the first file is read, so a bad --projectId imports nothing
    const targetProject = await importProject(ctx, tenant.id, args, actor);
    const items = await readInput(out, input, args.flag('separate'));

    let failed = 0;
    const fail = (label: string, text: string) => {
      failed++;
      out.stderr(`Could not import ${label}: ${text}\n`);
    };

    // first pass: save every file; the ids a file brings are kept or replaced, and mapped
    const idMap = new Map<string, string>();
    const saved: Imported[] = [];
    for (const [index, item] of items.entries()) {
      const name = (item as { name?: unknown } | null)?.name;
      const label = typeof name === 'string' && name ? `"${name.slice(0, 128)}"` : `workflow #${index + 1}`;
      const parsed = workflowCreateSchema.safeParse(item);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        fail(label, `${issue?.path.join('.') || 'the file'}: ${issue?.message ?? 'not a workflow'}`);
        continue;
      }
      const { folderId: _folder, tagIds: _tags, ...content } = parsed.data;
      const wanted = (item as { id?: unknown }).id;
      const sourceId = typeof wanted === 'string' && UUID.test(wanted) ? wanted.toLowerCase() : undefined;
      try {
        const existing = sourceId ? await ctx.repos.workflows.get(tenant.id, sourceId) : undefined;
        await evaluateWorkflow(ctx.serviceDeps, 'contentImport', {
          tenantId: tenant.id,
          projectId: existing?.projectId ?? targetProject,
          workflow: { nodes: content.nodes },
        });
        const result = existing
          ? await ctx.workflows.update(
              tenant.id,
              existing.id,
              { ...content, versionId: existing.versionId },
              actor,
              'Imported',
            )
          : await ctx.workflows.create(tenant.id, { ...content, projectId: targetProject }, actor);
        if (sourceId) idMap.set(sourceId, result.id);
        saved.push({ label, id: result.id, versionId: result.versionId, content });
        out.stdout(`Imported workflow ${label} (${result.id})\n`);
      } catch (error) {
        fail(label, refusal(error));
      }
    }

    // second pass: a file that points at another imported workflow now points at its new id
    for (const file of saved) {
      const rewritten = rewriteUuids(file.content, (id) => idMap.get(id));
      if (JSON.stringify(rewritten) === JSON.stringify(file.content)) continue;
      try {
        await ctx.workflows.update(
          tenant.id,
          file.id,
          { ...rewritten, versionId: file.versionId },
          actor,
          'Imported: references updated',
        );
      } catch (error) {
        fail(file.label, `its references to other imported workflows were not updated: ${refusal(error)}`);
      }
    }

    out.stdout(`Imported ${saved.length} of ${items.length} workflow(s).\n`);
    return failed === 0 ? 0 : 1;
  });
}
