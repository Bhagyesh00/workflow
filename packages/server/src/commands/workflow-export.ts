/**
 * P6-78 (L11): `export:workflow`. Dispatched by cli.ts inside `createContext`, the context closed after it; the
 * result is the exit code (0 ok), which cli.ts sets as `process.exitCode`. Output goes through `io` (default
 * `processIo()`), so tests capture it.
 * - export:workflow: `--tenant <slug>` with `--all` or `--id`, `--output`, `--pretty`, `--separate`, `--version`, `--published`
 * The file is a JSON list of workflows (the draft, or with `--version` / `--published` that saved version);
 * it holds no run data, no tenant id and no credential data (a node keeps its credential id and name).
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ServerContext } from '../context';
import { ApiError } from '../http/errors';
import {
  allWorkflows,
  CommandUsageError,
  parseCommandArgs,
  requireTenant,
  runCommand,
  toJson,
} from './command-args';
import type { CommandIo } from './command-io';

export const EXPORT_WORKFLOW_USAGE =
  'Usage: export:workflow --tenant <slug> (--all | --id <id>) [--output <path>] [--pretty] [--separate] [--version <versionId> | --published]';

export function exportWorkflowCommand(ctx: ServerContext, argv: string[], io?: CommandIo): Promise<number> {
  return runCommand(io, EXPORT_WORKFLOW_USAGE, async (out) => {
    const args = parseCommandArgs(argv, {
      values: ['tenant', 'id', 'output', 'version'],
      flags: ['all', 'pretty', 'separate', 'published'],
    });
    const tenant = await requireTenant(ctx, args);
    const id = args.value('id');
    const all = args.flag('all');
    if (all === (id !== undefined)) throw new CommandUsageError('Give exactly one of --all and --id');
    const version = args.value('version');
    const published = args.flag('published');
    if (version !== undefined && id === undefined) throw new CommandUsageError('--version needs --id');
    if (version !== undefined && published)
      throw new CommandUsageError('--version and --published exclude each other');
    const output = args.value('output');
    const separate = args.flag('separate');
    if (separate && output === undefined) throw new CommandUsageError('--separate needs --output <folder>');
    const pretty = args.flag('pretty');

    const ids = id !== undefined ? [id] : (await allWorkflows(ctx, tenant.id)).map((row) => row.id);
    const exported: Array<Record<string, unknown>> = [];
    for (const workflowId of ids) {
      const row = await ctx.workflows.get(tenant.id, workflowId);
      const dto = await ctx.workflows.dto(tenant.id, row);
      const tags = dto.tags.map((tag) => tag.name);
      const versionId = version ?? (published ? (row.publishedVersionId ?? undefined) : undefined);
      if (published && versionId === undefined) {
        // --all skips what is not published; --id says so
        if (id !== undefined) throw new Error(`Workflow "${row.name}" has no published version`);
        continue;
      }
      if (versionId === undefined) {
        exported.push({
          id: dto.id,
          name: dto.name,
          active: dto.active,
          nodes: dto.nodes,
          connections: dto.connections,
          settings: dto.settings,
          pinData: dto.pinData,
          stickyNotes: dto.stickyNotes,
          nodeGroups: dto.nodeGroups,
          tags,
        });
        continue;
      }
      const saved = await ctx.workflows.getVersion(tenant.id, workflowId, versionId).catch((error) => {
        if (error instanceof ApiError && error.statusCode === 404) throw new Error('Version not found');
        throw error;
      });
      exported.push({
        id: row.id,
        name: saved.name,
        active: row.active,
        versionId: saved.versionId,
        nodes: saved.nodes,
        connections: saved.connections,
        settings: saved.settings,
        stickyNotes: saved.stickyNotes,
        nodeGroups: saved.nodeGroups,
        tags,
      });
    }

    if (output === undefined) {
      out.stdout(toJson(exported, pretty));
      return 0;
    }
    if (separate) {
      await mkdir(output, { recursive: true });
      for (const workflow of exported) {
        await out.writeFile(path.join(output, `${String(workflow.id)}.json`), toJson(workflow, pretty), {});
      }
    } else {
      await out.writeFile(output, toJson(exported, pretty), {});
    }
    out.stdout(`Exported ${exported.length} workflow(s) to ${output}\n`);
    return 0;
  });
}
