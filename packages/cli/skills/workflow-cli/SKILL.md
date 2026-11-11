---
name: workflow-cli
description: Run the workflow CLI to list, read, create, update, publish and delete workflows, executions, credentials, projects, tags, variables, data tables and users of a workspace through its public API.
---

# Workflow CLI

Use the `workflow` command to work with a workspace from the terminal. It calls the public API with an API key.

## Sign in

- `workflow login --url https://workflow.example.com --api-key <key>` saves the URL and key to `~/.workflow/config.json` after checking them.
- Or set `WORKFLOW_URL` and `WORKFLOW_API_KEY`. Flags `--url` and `--api-key` win over the environment, the environment over the file.
- Never print, log or commit the key. Prefer the environment variable or `login` over `--api-key` (shell history keeps flags).
- `workflow config show` shows the URL and a masked key. `workflow logout` removes them.

## Output

- Output is JSON when it is piped and a table in a terminal. Force it with `--format table|json|id-only` or `--json`.
- `--pick data[0].id` or `--pick [].name` keeps one part of the result. `--quiet` prints nothing on success. `--no-header` drops the table header.
- Lists take `--limit <1-250>`, `--cursor <text>` and `--all` (follow every page).
- Exit codes: 0 ok, 1 error, 2 usage, 4 sign-in, 5 forbidden, 6 not found, 7 conflict, 8 server or network.

## Commands

- `workflow workflow list|get|create|update|delete|activate|deactivate|tags|transfer`
- `workflow execution list|get|retry|stop|delete`
- `workflow credential list|get|schema|create|delete|transfer` (answers never hold secret data)
- `workflow project list|get|create|update|delete|members|add-member|remove-member`
- `workflow tag list|get|create|update|delete` and `workflow variable list|get|create|update|delete`
- `workflow data-table list|get|create|delete|rows|add-rows|update-rows|upsert-rows|delete-rows`
- `workflow user list|get`, `workflow source-control pull`, `workflow audit`

Create and update take the JSON body from `--file <path>` or `--stdin`. Run `workflow <group> --help` for the flags of each command.

## Rules for an agent

- Read before you change: `get` the item, then `update` with the changed JSON.
- Ask the person before `delete`, `deactivate`, `transfer` or `delete-rows`, and before `source-control pull --force`.
- A 403 means the key or its user lacks a scope on that item; do not try another route around it.
- On a protected workspace the server refuses writes; report the refusal instead of retrying.
