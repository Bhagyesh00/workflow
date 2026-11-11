# Commands

`workflow <group> <command> [words] [flags]`. Every command also takes the output flags and `--url`, `--api-key` (see README.md). `workflow <group> --help` and `workflow <group> <command> --help` print the same usage as this page.

## workflow

| Command | Calls | Notes |
| --- | --- | --- |
| `workflow list` | `GET /workflows` | `--active[=false]`, `--project-id`, `--tag-id`, `--name` |
| `workflow get <id>` | `GET /workflows/:id` | |
| `workflow create` | `POST /workflows` | body from `--file` or `--stdin` |
| `workflow update <id>` | `PUT /workflows/:id` | body from `--file` or `--stdin`; `--publish-if-active true\|false` |
| `workflow delete <id>` | `DELETE /workflows/:id` | |
| `workflow activate <id>` | `POST /workflows/:id/activate` | `--version-id`, `--name`, `--description` |
| `workflow deactivate <id>` | `POST /workflows/:id/deactivate` | |
| `workflow tags <id>` | `GET /workflows/:id/tags` | with `--set a,b` it calls `PUT` with `[{ "id": "a" }, { "id": "b" }]`; `--set ""` clears |
| `workflow transfer <id>` | `PUT /workflows/:id/transfer` | `--destination-project-id`, `--destination-parent-folder-id` |

## execution

| Command | Calls | Notes |
| --- | --- | --- |
| `execution list` | `GET /executions` | `--workflow-id`, `--project-id`, `--status a,b` |
| `execution get <id>` | `GET /executions/:id` | `--include-data` |
| `execution retry <id>` | `POST /executions/:id/retry` | `--use-current-workflow` |
| `execution stop <id>` | `POST /executions/:id/stop` | needs the right to run the workflow |
| `execution delete <id>` | `DELETE /executions/:id` | |

## credential

Answers never hold secret data.

| Command | Calls | Notes |
| --- | --- | --- |
| `credential list` | `GET /credentials` | id, name, type; only the credentials your user can use |
| `credential get <id>` | `GET /credentials/:id` | |
| `credential schema <type>` | `GET /credentials/schema/:type` | the JSON schema of the data |
| `credential create` | `POST /credentials` | `{ name, type, data, projectId? }` from `--file` or `--stdin` |
| `credential delete <id>` | `DELETE /credentials/:id` | |
| `credential transfer <id>` | `PUT /credentials/:id/transfer` | `--destination-project-id` |

## project

| Command | Calls | Notes |
| --- | --- | --- |
| `project list` | `GET /projects` | |
| `project get <id>` | `GET /projects` | the API has no single-project route; the CLI finds it in the list |
| `project create` | `POST /projects` | `--name`, `--description` |
| `project update <id>` | `PUT /projects/:id` | `--name`, `--description` |
| `project delete <id>` | `DELETE /projects/:id` | `--transfer-id` moves its workflows and credentials |
| `project members <id>` | `GET /projects/:id/users` | |
| `project add-member <id>` | `POST /projects/:id/users` | `--user-id`, `--role` |
| `project remove-member <id>` | `DELETE /projects/:id/users/:userId` | `--user-id` |

## tag and variable

| Command | Calls |
| --- | --- |
| `tag list`, `tag get <id>` | `GET /tags`, `GET /tags/:id` |
| `tag create --name <text>` | `POST /tags` |
| `tag update <id> --name <text>` | `PUT /tags/:id` |
| `tag delete <id>` | `DELETE /tags/:id` |
| `variable list` | `GET /variables` (`--project-id`, `--empty`) |
| `variable get <id>` | `GET /variables` (found in the list) |
| `variable create --key <name> --value <text>` | `POST /variables` (`--project-id`) |
| `variable update <id>` | `PUT /variables/:id` (`--key`, `--value`) |
| `variable delete <id>` | `DELETE /variables/:id` |

## data-table

| Command | Calls | Notes |
| --- | --- | --- |
| `data-table list` | `GET /data-tables` | |
| `data-table get <id>` | `GET /data-tables/:id` | |
| `data-table create` | `POST /data-tables` | `{ name, columns: [{ name, type }], projectId? }` |
| `data-table delete <id>` | `DELETE /data-tables/:id` | |
| `data-table rows <id>` | `GET /data-tables/:id/rows` | `--filter <json>`, `--search`, `--sort-by col:asc` |
| `data-table add-rows <id>` | `POST /data-tables/:id/rows` | a JSON array of rows, or `{ data, returnType }`; `--return-type all\|id\|count` |
| `data-table update-rows <id>` | `PATCH /data-tables/:id/rows/update` | `--filter` and `--data` (JSON), or `{ filter, data }` from a file; `--dry-run` |
| `data-table upsert-rows <id>` | `POST /data-tables/:id/rows/upsert` | as `update-rows` |
| `data-table delete-rows <id>` | `DELETE /data-tables/:id/rows/delete` | `--filter <json>` (required), `--dry-run` |

A filter is `{"type":"and","filters":[{"columnName":"email","condition":"eq","value":"a@b.co"}]}`.

## user, source-control, audit

| Command | Calls | Notes |
| --- | --- | --- |
| `user list` | `GET /users` | `--include-role`, `--project-id` |
| `user get <id-or-email>` | `GET /users/:id` | `--include-role` |
| `source-control pull` | `POST /source-control/pull` | `--force`, `--auto-publish none\|all\|published` |
| `audit` | `POST /audit` | `--days-abandoned <days>`, `--categories a,b` |

## config, login, skill

| Command | Notes |
| --- | --- |
| `login --url <url> --api-key <key>` | checks with `GET /users`, then saves |
| `logout` | removes `~/.workflow/config.json` |
| `config set-url <url>` | saves the URL |
| `config set-api-key <key>` or `--stdin` | saves the key |
| `config show` | URL, masked key, and where each comes from |
| `skill install` | writes the agent skill under the current folder (`.claude/skills/workflow-cli/SKILL.md`); `--global` uses your home folder; `--target cursor` writes `.cursor/rules/workflow-cli.mdc`, `--target windsurf` writes `.windsurf/rules/workflow-cli.md` |
