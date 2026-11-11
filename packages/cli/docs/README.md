# workflow CLI

A command line client for the platform's public API. It runs from this repository (`packages/cli/bin/workflow.mjs`, a `workflow` bin) and calls `/api/v1` with an API key. It has no dependency beyond `tsx` and imports no other package of the monorepo.

```
node packages/cli/bin/workflow.mjs workflow list
```

## Sign in

Make an API key in the editor (Settings, API keys), then either:

```
workflow login --url https://workflow.example.com --api-key <key>
```

`login` checks the URL and key with `GET /users` and only then saves them to `~/.workflow/config.json`. There is no browser flow. `workflow logout` removes the file.

The CLI reads its settings in this order, the first one set wins:

1. Flags `--url` and `--api-key`.
2. Environment `WORKFLOW_URL` and `WORKFLOW_API_KEY`. (The names carry a `WORKFLOW_` prefix on purpose: bare `URL` or `API_KEY` would clash with other tools in your shell.)
3. The file `~/.workflow/config.json`.

`workflow config set-url <url>`, `workflow config set-api-key <key>` and `workflow config show` edit and show it. `config show` prints the URL and the length of the key, never the key.

## Keeping the key safe

- The key is sent only in the `X-API-KEY` header, only to the URL you gave. It is never put in a URL and never printed. Redirects are not followed, so a redirecting server cannot receive it. Error text has the key cut out.
- A flag such as `--api-key` stays in your shell history. Prefer `login`, the environment, or `workflow config set-api-key --stdin` (pipe the key in).
- The file `~/.workflow/config.json` is written with mode 0600 (owner read and write). On Windows the mode has no effect and no access list is set: the file takes the rights of your user folder, so keep that folder private.
- Plain `http://` is accepted for `localhost`, `127.0.0.1` and `[::1]`. For any other host the CLI refuses it unless you pass `--allow-http` (or set `WORKFLOW_ALLOW_HTTP=1`), because the key would cross the network unencrypted.

## Output

| Flag | Effect |
| --- | --- |
| `--format table` | A table (the default in a terminal). |
| `--format json`, `--json` | JSON (the default when output is piped). |
| `--format id-only` | One id per line. |
| `--pick <path>` | Keeps one part of the result before the format, such as `data[0].id` or `[].name`. |
| `--quiet`, `-q` | Prints nothing on success. |
| `--no-header` | No header line in a table. |

Lists take `--limit <1-250>`, `--cursor <text>` and `--all` (follow every page). Without `--all`, a next cursor is shown on stderr.

## Bodies from a file

`create` and `update` commands take their JSON body from `--file <path>` or `--stdin`.

```
workflow workflow create --file flow.json
cat flow.json | workflow workflow update <id> --stdin
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | General error (also a redirect). |
| 2 | Usage error, or the server refused the request as invalid (400, 422). |
| 4 | No URL or key, or the server answered 401. |
| 5 | The key's user may not do this (403). |
| 6 | Not found (404). |
| 7 | Conflict (409). |
| 8 | Server error (5xx) or the server could not be reached. |

## What the server decides

The CLI is only a client. A key does what its user may do and what its scopes allow; a protected workspace refuses writes on the server. A 403 means the key or its user lacks a scope on that item.

See [commands.md](commands.md) for every command, and `workflow skill install` to give a coding agent the same knowledge.
