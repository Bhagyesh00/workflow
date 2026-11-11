/** `workflow workflow ...` (P6-77): workflows on the public API. */
import { flagBool, flagRequired, flagText, UsageError, wordRequired } from '../args';
import { type CommandGroup, pagingOf } from '../client';

const COLUMNS = ['id', 'name', 'active', 'updatedAt'] as const;
const enc = encodeURIComponent;

export const workflowCommands: CommandGroup = {
  list: {
    summary: 'List workflows',
    usage:
      'workflow workflow list [--active[=false]] [--project-id <id>] [--tag-id <id>] [--name <text>] [--limit n] [--cursor c] [--all]',
    async run(ctx) {
      const { query, all } = pagingOf(ctx.args);
      const page = await (await ctx.api()).list(
        '/workflows',
        {
          ...query,
          active: flagBool(ctx.args, 'active'),
          projectId: flagText(ctx.args, 'project-id'),
          tagId: flagText(ctx.args, 'tag-id'),
          name: flagText(ctx.args, 'name'),
        },
        { all },
      );
      ctx.print(page.data, COLUMNS);
      if (page.nextCursor) ctx.note(`More results: --cursor ${page.nextCursor} (or --all)`);
    },
  },
  get: {
    summary: 'Show one workflow',
    usage: 'workflow workflow get <id>',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      ctx.print(await (await ctx.api()).data('GET', `/workflows/${enc(id)}`));
    },
  },
  create: {
    summary: 'Create a workflow from JSON',
    usage: 'workflow workflow create (--file <path> | --stdin)',
    async run(ctx) {
      const body = await ctx.body();
      ctx.print(await (await ctx.api()).data('POST', '/workflows', { body }), COLUMNS);
    },
  },
  update: {
    summary:
      'Replace a workflow with JSON (a published workflow is published again unless --publish-if-active false)',
    usage: 'workflow workflow update <id> (--file <path> | --stdin) [--publish-if-active true|false]',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const publish = flagText(ctx.args, 'publish-if-active');
      if (publish !== undefined && publish !== 'true' && publish !== 'false') {
        throw new UsageError('--publish-if-active must be true or false');
      }
      const body = await ctx.body();
      ctx.print(
        await (await ctx.api()).data('PUT', `/workflows/${enc(id)}`, {
          body,
          query: { publishIfActive: publish },
        }),
        COLUMNS,
      );
    },
  },
  delete: {
    summary: 'Delete a workflow',
    usage: 'workflow workflow delete <id>',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      ctx.print(await (await ctx.api()).data('DELETE', `/workflows/${enc(id)}`));
    },
  },
  activate: {
    summary: 'Publish a workflow (the current version, or --version-id)',
    usage: 'workflow workflow activate <id> [--version-id <id>] [--name <text>] [--description <text>]',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const body = {
        versionId: flagText(ctx.args, 'version-id'),
        name: flagText(ctx.args, 'name'),
        description: flagText(ctx.args, 'description'),
      };
      ctx.print(await (await ctx.api()).data('POST', `/workflows/${enc(id)}/activate`, { body }), COLUMNS);
    },
  },
  deactivate: {
    summary: 'Unpublish a workflow',
    usage: 'workflow workflow deactivate <id>',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      ctx.print(
        await (await ctx.api()).data('POST', `/workflows/${enc(id)}/deactivate`, { body: {} }),
        COLUMNS,
      );
    },
  },
  tags: {
    summary: 'Show the tags of a workflow, or set them with --set (a comma list of tag ids; empty clears)',
    usage: 'workflow workflow tags <id> [--set <tagId,tagId>]',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const api = await ctx.api();
      const set = ctx.args.flags.set;
      if (set === undefined) {
        ctx.print(await api.data('GET', `/workflows/${enc(id)}/tags`), ['id', 'name']);
        return;
      }
      const ids =
        typeof set === 'string'
          ? set
              .split(',')
              .map((part) => part.trim())
              .filter(Boolean)
          : [];
      const body = ids.map((tagId) => ({ id: tagId }));
      ctx.print(await api.data('PUT', `/workflows/${enc(id)}/tags`, { body }), ['id', 'name']);
    },
  },
  transfer: {
    summary: 'Move a workflow to another project',
    usage:
      'workflow workflow transfer <id> --destination-project-id <id> [--destination-parent-folder-id <id>]',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const body = {
        destinationProjectId: flagRequired(ctx.args, 'destination-project-id'),
        destinationParentFolderId: flagText(ctx.args, 'destination-parent-folder-id'),
      };
      ctx.print(await (await ctx.api()).data('PUT', `/workflows/${enc(id)}/transfer`, { body }));
    },
  },
};
