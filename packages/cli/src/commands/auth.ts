/**
 * `workflow login` and `workflow logout` (P6-77). `login` takes the URL and key from flags or the environment,
 * checks them with GET /users (a key that cannot call it fails), and only then saves them with mode 0600.
 * No browser flow. `logout` removes the saved file.
 */
import { ApiClient, CliError, type Command, EXIT } from '../client';
import { clearConfig, ENV_API_KEY, normalizeUrl, resolveConfig, writeConfig } from '../config';

export const loginCommand: Command = {
  summary: 'Check a server URL and API key and save them',
  usage: 'workflow login --url <url> --api-key <key> [--allow-http]',
  async run(ctx) {
    const config = await resolveConfig(ctx.args, ctx.io);
    if (!config.url || !config.apiKey) {
      throw new CliError('Give --url and --api-key (or set WORKFLOW_URL and WORKFLOW_API_KEY)', EXIT.usage);
    }
    const url = normalizeUrl(config.url, config.allowHttp);
    await new ApiClient(ctx.io, url, config.apiKey).request('GET', '/users', { query: { limit: 1 } });
    await writeConfig(ctx.io, { url, apiKey: config.apiKey });
    ctx.print({ loggedIn: true, url });
  },
};

export const logoutCommand: Command = {
  summary: 'Remove the saved URL and key',
  usage: 'workflow logout',
  async run(ctx) {
    await clearConfig(ctx.io);
    ctx.print({ loggedOut: true });
    if (ctx.io.env[ENV_API_KEY]) ctx.note(`${ENV_API_KEY} is set in your environment; unset it too.`);
  },
};
