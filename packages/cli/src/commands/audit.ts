/** `workflow audit` (P6-77): generates the security audit of the workspace. */
import { flagInt, flagText } from '../args';
import type { Command } from '../client';

export const auditCommand: Command = {
  summary: 'Generate a security audit report',
  usage: 'workflow audit [--days-abandoned <1-36500>] [--categories a,b]',
  async run(ctx) {
    const days = flagInt(ctx.args, 'days-abandoned', 1, 36500);
    const categories = flagText(ctx.args, 'categories')
      ?.split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const options = { daysAbandonedWorkflow: days, categories: categories?.length ? categories : undefined };
    const body = days !== undefined || options.categories ? { additionalOptions: options } : {};
    ctx.print(await (await ctx.api()).data('POST', '/audit', { body }));
  },
};
