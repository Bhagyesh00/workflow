import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import tokens from './css-tokens.json';

const SRC = join(import.meta.dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

const read = (path: string) => readFileSync(path, 'utf8');
const css = read(join(SRC, 'chat.css'));
const codeFiles = sourceFiles(SRC).filter((f) => f.endsWith('.ts'));

describe('chat.css', () => {
  it('reads every one of the 115 variable names', () => {
    expect(tokens).toHaveLength(115);
    const unread = (tokens as string[]).filter((name) => !css.includes(`var(${name})`));
    expect(unread).toEqual([]);
  });

  it('defines every one of the names with a value', () => {
    const undefinedNames = (tokens as string[]).filter((name) => !new RegExp(`${name}:\\s*[^;]+;`).test(css));
    expect(undefinedNames).toEqual([]);
  });

  it('uses chat-* class names and no Shadow DOM', () => {
    const classes = Array.from(css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)).map(
      (m) => m[1] as string,
    );
    const own = classes.filter((c) => !c.startsWith('hljs-'));
    expect(own.length).toBeGreaterThan(40);
    expect(own.every((c) => c.startsWith('chat-'))).toBe(true);
    for (const file of codeFiles) expect(read(file)).not.toMatch(/attachShadow/);
  });
});

describe('source rules', () => {
  it('markdown.ts writes no HTML string and creates no image element', () => {
    const markdown = read(join(SRC, 'markdown.ts'));
    for (const banned of [
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'localStorage',
      'sessionStorage',
      'document.cookie',
      'eval(',
      'new Function',
      "createElement('img')",
      'createElement("img")',
    ]) {
      expect(markdown).not.toContain(banned);
    }
  });

  it('no source file writes HTML strings, touches storage or cookies, or evaluates code', () => {
    for (const file of codeFiles) {
      const text = read(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      for (const banned of [
        'innerHTML',
        'outerHTML',
        'insertAdjacentHTML',
        'document.write',
        'localStorage',
        'sessionStorage',
        'document.cookie',
        'eval(',
        'new Function',
      ]) {
        expect(text, `${file} has ${banned}`).not.toContain(banned);
      }
    }
  });

  it('every fetch goes through the one helper that sets credentials omit', () => {
    const calls = codeFiles.filter((f) =>
      /\bfetch\(/.test(read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')),
    );
    expect(calls.map((f) => f.replace(SRC, '').replace(/\\/g, '/'))).toEqual(['/api.ts']);
    const api = read(join(SRC, 'api.ts'));
    expect(api).toContain("credentials: 'omit'");
    expect((api.match(/doFetch\(/g) ?? []).length).toBe(1);
  });

  it('allows exactly http, https and mailto for links', () => {
    expect(read(join(SRC, 'markdown.ts'))).toContain("new Set(['http:', 'https:', 'mailto:'])");
  });

  it('checks the webhook origin for buttons and for the resume URL of a wait frame', () => {
    expect(read(join(SRC, 'components', 'buttons.ts'))).toContain(
      'hasWebhookOrigin(spec.link, deps.webhookUrl)',
    );
    expect(read(join(SRC, 'index.ts'))).toContain('hasWebhookOrigin(url, options.webhookUrl)');
  });

  it('has no vendor name and no Powered-by text', () => {
    for (const file of [...codeFiles, join(SRC, 'chat.css')]) {
      const text = read(file);
      expect(text, file).not.toMatch(/n8n/i);
      expect(text, file).not.toMatch(/powered by/i);
    }
  });
});
