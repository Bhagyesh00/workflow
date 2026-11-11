import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CliIo } from '../src/index';
import { run } from '../src/index';
import { SKILL_BODY, SKILL_TARGETS, SKILL_TEXT, skillFor, skillPath } from '../src/skill';

function ioWith(home = '/home/me') {
  const writes: Array<{ path: string; data: string; options: { mode?: number } }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env: {},
    home,
    fetch: globalThis.fetch,
    stdin: async () => '',
    isTTY: false,
    readFile: async () => undefined,
    writeFile: async (path, data, options) => {
      writes.push({ path, data, options });
    },
    removeFile: async () => {},
  };
  return { io, writes, out, err };
}

describe('the skill text', () => {
  it('skills/workflow-cli/SKILL.md is the text the command writes', () => {
    const file = readFileSync(new URL('../skills/workflow-cli/SKILL.md', import.meta.url), 'utf8');
    expect(file).toBe(SKILL_TEXT);
    expect(SKILL_TEXT.startsWith('---\nname: workflow-cli\ndescription: ')).toBe(true);
  });

  it('names every command group and never a key', () => {
    for (const word of [
      'workflow list',
      'execution',
      'credential',
      'project',
      'data-table',
      'source-control pull',
      'audit',
      'login',
    ]) {
      expect(SKILL_BODY).toContain(word.split(' ')[0]);
    }
    expect(SKILL_BODY).not.toMatch(/n8n/i);
  });

  it('each agent gets its own format', () => {
    expect(skillFor('claude')).toBe(SKILL_TEXT);
    expect(skillFor('cursor')).toContain('alwaysApply: false');
    expect(skillFor('cursor')).toContain(SKILL_BODY);
    expect(skillFor('windsurf')).toBe(SKILL_BODY);
  });

  it('paths: this folder, or the home folder with --global', () => {
    expect(skillPath('claude', false, '/h')).toBe('.claude/skills/workflow-cli/SKILL.md');
    expect(skillPath('claude', true, '/h/')).toBe('/h/.claude/skills/workflow-cli/SKILL.md');
    expect(skillPath('cursor', false, '/h')).toBe('.cursor/rules/workflow-cli.mdc');
    expect(skillPath('windsurf', true, '/h')).toBe('/h/.windsurf/rules/workflow-cli.md');
    expect(SKILL_TARGETS).toEqual(['claude', 'cursor', 'windsurf']);
  });
});

describe('workflow skill install', () => {
  it('writes the Claude skill under the current folder by default', async () => {
    const { io, writes } = ioWith();
    expect(await run(['skill', 'install'], io)).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('.claude/skills/workflow-cli/SKILL.md');
    expect(writes[0].data).toBe(SKILL_TEXT);
  });

  it('--global goes to the home folder and --target picks cursor or windsurf', async () => {
    const a = ioWith('/home/me');
    expect(await run(['skill', 'install', '--global', '--target', 'cursor'], a.io)).toBe(0);
    expect(a.writes[0].path).toBe('/home/me/.cursor/rules/workflow-cli.mdc');
    expect(a.writes[0].data).toBe(skillFor('cursor'));
    const b = ioWith();
    expect(await run(['skill', 'install', '--target', 'windsurf'], b.io)).toBe(0);
    expect(b.writes[0].path).toBe('.windsurf/rules/workflow-cli.md');
  });

  it('an unknown target is a usage error and writes nothing', async () => {
    const { io, writes, err } = ioWith();
    expect(await run(['skill', 'install', '--target', 'vim'], io)).toBe(2);
    expect(writes).toHaveLength(0);
    expect(err.join('')).toMatch(/--target must be one of/);
  });
});
