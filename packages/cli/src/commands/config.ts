/** `workflow config set-url | set-api-key | show` (P6-77). The key is never printed: `show` masks it. */
import { flagOn, UsageError } from '../args';
import type { CommandGroup } from '../client';
import { configPath, maskKey, normalizeUrl, readConfig, resolveConfig, writeConfig } from '../config';

export const configCommands: CommandGroup = {
  'set-url': {
    summary: 'Save the server URL',
    usage: 'workflow config set-url <url> [--allow-http]',
    async run(ctx) {
      const raw = ctx.args.positionals[0];
      if (!raw) throw new UsageError('Missing <url>');
      const url = normalizeUrl(raw, flagOn(ctx.args, 'allow-http'));
      await writeConfig(ctx.io, { ...(await readConfig(ctx.io)), url });
      ctx.print({ url });
    },
  },
  'set-api-key': {
    summary: 'Save the API key (read from stdin with --stdin, so it stays out of the shell history)',
    usage: 'workflow config set-api-key (<key> | --stdin)',
    async run(ctx) {
      const given = flagOn(ctx.args, 'stdin') ? (await ctx.io.stdin()).trim() : ctx.args.positionals[0];
      if (!given) throw new UsageError('Give the key as <key>, or pipe it in with --stdin');
      await writeConfig(ctx.io, { ...(await readConfig(ctx.io)), apiKey: given });
      ctx.print({ apiKey: maskKey(given) });
    },
  },
  show: {
    summary: 'Show the URL and a masked key, and where each comes from',
    usage: 'workflow config show',
    async run(ctx) {
      const config = await resolveConfig(ctx.args, ctx.io);
      ctx.print({
        url: config.url ?? '(not set)',
        urlSource: config.source.url,
        apiKey: maskKey(config.apiKey),
        apiKeySource: config.source.apiKey,
        configFile: configPath(ctx.io),
      });
    },
  },
};
