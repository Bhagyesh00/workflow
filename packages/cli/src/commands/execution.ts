/** `workflow execution ...` (P6-77): runs on the public API. */
import { flagOn, flagText, wordRequired } from '../args';
import { type CommandGroup, pagingOf } from '../client';

const COLUMNS = ['id', 'workflowId', 'status', 'mode', 'startedAt', 'stoppedAt'] as const;
const enc = encodeURIComponent;

export const executionCommands: CommandGroup = {
  list: {
    summary: 'List executions',
    usage:
      'workflow execution list [--workflow-id <id>] [--project-id <id>] [--status a,b] [--limit n] [--cursor c] [--all]',
    async run(ctx) {
      const { query, all } = pagingOf(ctx.args);
      const page = await (await ctx.api()).list(
        '/executions',
        {
          ...query,
          workflowId: flagText(ctx.args, 'workflow-id'),
          projectId: flagText(ctx.args, 'project-id'),
          status: flagText(ctx.args, 'status'),
        },
        { all },
      );
      ctx.print(page.data, COLUMNS);
      if (page.nextCursor) ctx.note(`More results: --cursor ${page.nextCursor} (or --all)`);
    },
  },
  get: {
    summary: 'Show one execution (--include-data adds the run data)',
    usage: 'workflow execution get <id> [--include-data]',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const query = { includeData: flagOn(ctx.args, 'include-data') ? true : undefined };
      ctx.print(await (await ctx.api()).data('GET', `/executions/${enc(id)}`, { query }));
    },
  },
  retry: {
    summary: 'Retry a failed execution',
    usage: 'workflow execution retry <id> [--use-current-workflow]',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const body = { useCurrentWorkflow: flagOn(ctx.args, 'use-current-workflow') ? true : undefined };
      ctx.print(await (await ctx.api()).data('POST', `/executions/${enc(id)}/retry`, { body }));
    },
  },
  stop: {
    summary: 'Stop a running or waiting execution',
    usage: 'workflow execution stop <id>',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      ctx.print(await (await ctx.api()).data('POST', `/executions/${enc(id)}/stop`, { body: {} }));
    },
  },
  delete: {
    summary: 'Delete an execution',
    usage: 'workflow execution delete <id>',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      ctx.print(await (await ctx.api()).data('DELETE', `/executions/${enc(id)}`));
    },
  },
};
