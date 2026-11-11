/**
 * The agent skill `workflow skill install` writes (P6-77): our own text that teaches a coding agent the CLI.
 * `skills/workflow-cli/SKILL.md` holds the same text (a test keeps the two equal). Files go through CliIo.
 */

export type SkillTarget = 'claude' | 'cursor' | 'windsurf';

export const SKILL_TARGETS: readonly SkillTarget[] = ['claude', 'cursor', 'windsurf'];

export const SKILL_NAME = 'workflow-cli';
export const SKILL_DESCRIPTION =
  'Run the workflow CLI to list, read, create, update, publish and delete workflows, executions, credentials, projects, tags, variables, data tables and users of a workspace through its public API.';

const BODY_LINES: readonly string[] = [
  '# Workflow CLI',
  '',
  'Use the `workflow` command to work with a workspace from the terminal. It calls the public API with an API key.',
  '',
  '## Sign in',
  '',
  '- `workflow login --url https://workflow.example.com --api-key <key>` saves the URL and key to `~/.workflow/config.json` after checking them.',
  '- Or set `WORKFLOW_URL` and `WORKFLOW_API_KEY`. Flags `--url` and `--api-key` win over the environment, the environment over the file.',
  '- Never print, log or commit the key. Prefer the environment variable or `login` over `--api-key` (shell history keeps flags).',
  '- `workflow config show` shows the URL and a masked key. `workflow logout` removes them.',
  '',
  '## Output',
  '',
  '- Output is JSON when it is piped and a table in a terminal. Force it with `--format table|json|id-only` or `--json`.',
  '- `--pick data[0].id` or `--pick [].name` keeps one part of the result. `--quiet` prints nothing on success. `--no-header` drops the table header.',
  '- Lists take `--limit <1-250>`, `--cursor <text>` and `--all` (follow every page).',
  '- Exit codes: 0 ok, 1 error, 2 usage, 4 sign-in, 5 forbidden, 6 not found, 7 conflict, 8 server or network.',
  '',
  '## Commands',
  '',
  '- `workflow workflow list|get|create|update|delete|activate|deactivate|tags|transfer`',
  '- `workflow execution list|get|retry|stop|delete`',
  '- `workflow credential list|get|schema|create|delete|transfer` (answers never hold secret data)',
  '- `workflow project list|get|create|update|delete|members|add-member|remove-member`',
  '- `workflow tag list|get|create|update|delete` and `workflow variable list|get|create|update|delete`',
  '- `workflow data-table list|get|create|delete|rows|add-rows|update-rows|upsert-rows|delete-rows`',
  '- `workflow user list|get`, `workflow source-control pull`, `workflow audit`',
  '',
  'Create and update take the JSON body from `--file <path>` or `--stdin`. Run `workflow <group> --help` for the flags of each command.',
  '',
  '## Rules for an agent',
  '',
  '- Read before you change: `get` the item, then `update` with the changed JSON.',
  '- Ask the person before `delete`, `deactivate`, `transfer` or `delete-rows`, and before `source-control pull --force`.',
  '- A 403 means the key or its user lacks a scope on that item; do not try another route around it.',
  '- On a protected workspace the server refuses writes; report the refusal instead of retrying.',
];

export const SKILL_BODY = `${BODY_LINES.join('\n')}\n`;

/** the whole SKILL.md of the Claude Code skill (front matter and body) */
export const SKILL_TEXT = `---\nname: ${SKILL_NAME}\ndescription: ${SKILL_DESCRIPTION}\n---\n\n${SKILL_BODY}`;

/** the file text for one agent */
export function skillFor(target: SkillTarget): string {
  if (target === 'claude') return SKILL_TEXT;
  if (target === 'cursor') {
    return `---\ndescription: ${SKILL_DESCRIPTION}\nglobs:\nalwaysApply: false\n---\n\n${SKILL_BODY}`;
  }
  return SKILL_BODY;
}

/** where it goes: under the current folder, or with `global` under the home folder */
export function skillPath(target: SkillTarget, global: boolean, home: string): string {
  const relative =
    target === 'claude'
      ? `.claude/skills/${SKILL_NAME}/SKILL.md`
      : target === 'cursor'
        ? `.cursor/rules/${SKILL_NAME}.mdc`
        : `.windsurf/rules/${SKILL_NAME}.md`;
  return global ? `${home.replace(/[\\/]+$/, '')}/${relative}` : relative;
}
