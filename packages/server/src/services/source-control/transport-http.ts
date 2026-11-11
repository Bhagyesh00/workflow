/**
 * P6-72 (L1): isomorphic-git's HTTP plugin on `ctx.http` (the SSRF-guarded client): every request goes through it
 * (`bodyType: 'raw'`, `responseType: 'stream'`, `ignoreHttpStatusErrors`), redirects are checked again by the client
 * and `allowedDomains` is the remote host, so a redirect never carries the token to another host. Smart HTTP
 * protocol v1 only; a token is never sent over plain `http://` (named deviation: n8n sends it). The client's cap of
 * one response (100 MiB) applies to every answer, so `responseType: 'stream'` stays capped.
 */
import type { HttpClient } from '@workflow/core';
import type { HttpFullResponse } from '@workflow/workflow';
import type { HttpClient as IsomorphicGitHttpClient } from 'isomorphic-git';
import { GitRemoteError } from './git-repo';
import type { ParsedRemote } from './url';

/** what isomorphic-git takes as `http` (its `HttpClient` type: `{ request }`) */
export type GitHttpPlugin = IsomorphicGitHttpClient;

type PluginRequest = Parameters<GitHttpPlugin['request']>[0];
type PluginResponse = Awaited<ReturnType<GitHttpPlugin['request']>>;

/** headers the plugin never passes on from isomorphic-git: auth is ours, and protocol v2 is never asked for */
const DROPPED_HEADERS = new Set(['authorization', 'git-protocol', 'cookie', 'proxy-authorization', 'host']);

/** the base URL of the repository, as `withRepo` hands it to isomorphic-git */
export function remoteBaseUrl(remote: ParsedRemote): string {
  const host = remote.host.includes(':') ? `[${remote.host}]` : remote.host;
  const path = remote.path.startsWith('/') ? remote.path : `/${remote.path}`;
  return `${remote.kind}://${host}:${remote.port}${encodeURI(path).replace(/\/+$/, '')}`;
}

/** the plugin for one https (or tokenless http) remote */
export function gitHttpTransport(
  http: HttpClient,
  remote: ParsedRemote,
  auth?: { username: string; token: string },
): GitHttpPlugin {
  if (remote.kind === 'ssh') throw new GitRemoteError('An SSH repository URL needs an SSH key, not a token.');
  if (auth && remote.kind !== 'https') {
    throw new GitRemoteError('A token is never sent over plain http://. Use an https:// repository URL.');
  }
  const base = remoteBaseUrl(remote);
  const authorization = auth
    ? `Basic ${Buffer.from(`${auth.username || 'git'}:${auth.token}`, 'utf8').toString('base64')}`
    : undefined;

  return {
    async request({ url, method, headers, body }: PluginRequest): Promise<PluginResponse> {
      // isomorphic-git only appends `/info/refs?service=...` or `/git-...-pack` to the base it was given
      if (!url.startsWith(`${base}/`)) throw new GitRemoteError('The Git request left the repository URL.');
      const verb = (method ?? 'GET').toUpperCase();
      if (verb !== 'GET' && verb !== 'POST') throw new GitRemoteError('Only GET and POST are used.');
      const sent: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers ?? {})) {
        if (!DROPPED_HEADERS.has(name.toLowerCase())) sent[name.toLowerCase()] = String(value);
      }
      if (authorization) sent.authorization = authorization;
      let payload: Buffer | undefined;
      if (verb === 'POST' && body) {
        const parts: Buffer[] = [];
        for await (const chunk of body as AsyncIterable<Uint8Array>) parts.push(Buffer.from(chunk));
        payload = Buffer.concat(parts);
      }
      const response = (await http.request({
        url,
        method: verb,
        headers: sent,
        body: payload,
        bodyType: 'raw',
        responseType: 'stream',
        ignoreHttpStatusErrors: true,
        returnFullResponse: true,
        // the token goes to the remote host only: a redirect to any other host is refused before it is sent
        allowedDomains: authorization ? [remote.host] : undefined,
      })) as HttpFullResponse<AsyncIterable<Uint8Array>>;
      const stream = response.body;
      return {
        url,
        method: verb,
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        headers: response.headers,
        body: (async function* () {
          if (stream) yield* stream;
        })(),
      };
    },
  };
}
