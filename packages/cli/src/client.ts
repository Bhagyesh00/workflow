/**
 * The public API client and the shared command types (P6-77). The key goes only in the `X-API-KEY` header, to the
 * server URL the user gave and nowhere else: redirects are not followed (a redirect would carry the header to
 * another host), and any text that reaches an error or the screen has the key cut out of it.
 */
import { type Args, flagInt, flagOn, flagText, UsageError } from './args';
import { normalizeUrl, resolveConfig } from './config';
import type { CliIo } from './index';
import type { OutputOptions } from './output';

/** exit codes: 0 ok, 1 general, 2 usage, 4 sign-in (missing key, 401), 5 forbidden, 6 not found, 7 conflict, 8 server or network */
export const EXIT = {
  ok: 0,
  general: 1,
  usage: 2,
  auth: 4,
  forbidden: 5,
  notFound: 6,
  conflict: 7,
  server: 8,
} as const;

/** a failure with the exit code the process returns; `message` is safe to print */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.general,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export interface Page {
  data: unknown[];
  nextCursor: string | null;
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
}

function exitCodeFor(status: number): number {
  if (status === 401) return EXIT.auth;
  if (status === 403) return EXIT.forbidden;
  if (status === 404) return EXIT.notFound;
  if (status === 409) return EXIT.conflict;
  if (status >= 500) return EXIT.server;
  return EXIT.usage;
}

/** the text of a server error body: `{ error: { message } }`, or `{ message }`, else the status line */
function errorText(status: number, body: unknown): string {
  const nested = (body as { error?: { message?: unknown } } | null)?.error?.message;
  const flat = (body as { message?: unknown } | null)?.message;
  const text = typeof nested === 'string' ? nested : typeof flat === 'string' ? flat : undefined;
  return text ? `${text} (HTTP ${status})` : `The server answered HTTP ${status}`;
}

export class ApiClient {
  constructor(
    private readonly io: CliIo,
    private readonly base: string,
    private readonly apiKey: string,
  ) {}

  /** cuts the key out of text that is about to be shown */
  private scrub(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join('[key]') : text;
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = new URL(`${this.base}/api/v1${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const headers: Record<string, string> = { 'X-API-KEY': this.apiKey, Accept: 'application/json' };
    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }
    let response: Response;
    try {
      response = await this.io.fetch(url, { method, headers, body, redirect: 'manual' });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      throw new CliError(`Couldn't reach ${this.base}: ${this.scrub(reason)}`, EXIT.server);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new CliError(
        `The server at ${this.base} redirected the request. Check the URL (use the final https:// address)`,
        EXIT.general,
      );
    }
    const text = await response.text();
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!response.ok)
      throw new CliError(this.scrub(errorText(response.status, parsed)), exitCodeFor(response.status));
    return parsed;
  }

  /** the `data` of an answer */
  async data(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const answer = (await this.request(method, path, options)) as { data?: unknown } | undefined;
    return answer?.data;
  }

  /** one page, or with `all` every page, of a list route */
  async list(path: string, query: Query, paging: { all: boolean }): Promise<Page> {
    const items: unknown[] = [];
    let cursor = query.cursor === undefined ? undefined : String(query.cursor);
    for (let guard = 0; guard < 10000; guard += 1) {
      const answer = (await this.request('GET', path, { query: { ...query, cursor } })) as
        | { data?: unknown; nextCursor?: string | null }
        | undefined;
      const data = Array.isArray(answer?.data) ? answer.data : [];
      items.push(...data);
      const next = typeof answer?.nextCursor === 'string' && answer.nextCursor ? answer.nextCursor : null;
      if (!paging.all || !next) return { data: items, nextCursor: next };
      cursor = next;
    }
    throw new CliError('Too many pages; narrow the list with a filter', EXIT.general);
  }
}

/** what a command gets */
export interface Ctx {
  io: CliIo;
  args: Args;
  output: OutputOptions;
  /** the signed-in client; throws exit 4 when no URL or key is set */
  api(): Promise<ApiClient>;
  /** prints a result by the output options (nothing with --quiet) */
  print(value: unknown, columns?: readonly string[]): void;
  /** a line for the person, not data (stderr); nothing with --quiet */
  note(text: string): void;
  /** the JSON body from --file or --stdin; a usage error when neither is given */
  body(): Promise<unknown>;
}

export interface Command {
  summary: string;
  usage: string;
  run(ctx: Ctx): Promise<void>;
}

/** a table of commands of one group, by sub-command name */
export type CommandGroup = Record<string, Command>;

export async function buildApi(args: Args, io: CliIo): Promise<ApiClient> {
  const config = await resolveConfig(args, io);
  if (!config.url || !config.apiKey) {
    throw new CliError(
      'No server URL or API key. Run `workflow login --url <url> --api-key <key>`, or set WORKFLOW_URL and WORKFLOW_API_KEY',
      EXIT.auth,
    );
  }
  return new ApiClient(io, normalizeUrl(config.url, config.allowHttp), config.apiKey);
}

/** reads the JSON body from `--file <path>` or `--stdin`; the file's text is never echoed in an error */
export async function readJsonInput(args: Args, io: CliIo): Promise<unknown> {
  const file = flagText(args, 'file');
  const fromStdin = flagOn(args, 'stdin');
  if (file !== undefined && fromStdin) throw new UsageError('Use --file or --stdin, not both');
  let text: string | undefined;
  if (file !== undefined) {
    text = await io.readFile(file);
    if (text === undefined) throw new UsageError(`File not found: ${file}`);
  } else if (fromStdin) {
    text = await io.stdin();
  } else {
    throw new UsageError('Give the JSON with --file <path> or --stdin');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(
      file !== undefined ? `${file} is not valid JSON` : 'The input on stdin is not valid JSON',
    );
  }
}

/** `--limit`, `--cursor` and `--all` of a list command */
export function pagingOf(args: Args): { query: Query; all: boolean } {
  return {
    query: { limit: flagInt(args, 'limit', 1, 250), cursor: flagText(args, 'cursor') },
    all: flagOn(args, 'all'),
  };
}
