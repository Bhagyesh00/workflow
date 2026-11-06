import { readFileSync } from 'node:fs';
import { PyodideCodeRunner } from '@workflow/core';
import type { NodeProperty } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { CodeNode } from '../src/nodes/core/simple.nodes';
import { runNode } from './harness';

const pythonRunner = new PyodideCodeRunner({
  memoryLimitMb: 256,
  timeoutMs: 20_000,
  maxConcurrency: 5,
  stdlibAllow: [],
  externalAllow: [],
  builtinsDeny: ['open', 'eval', 'exec'],
  allowTransitiveImports: false,
});
const services = { pythonRunner };

const properties = CodeNode.description.properties as NodeProperty[];
const copies = (name: string) => properties.filter((p) => p.name === name);

describe('Code node description', () => {
  it('offers JavaScript and Python, JavaScript first and by default', () => {
    const language = properties.find((p) => p.name === 'language');
    expect(language?.default).toBe('javaScript');
    expect(language?.noDataExpression).toBe(true);
    expect(language?.options?.map((o) => ('value' in o ? o.value : undefined))).toEqual([
      'javaScript',
      'pythonNative',
    ]);
  });

  it('has one pythonCode per mode, for both stored language values', () => {
    const python = copies('pythonCode');
    expect(python.map((p) => p.displayOptions?.show?.mode)).toEqual([
      ['runOnceForAllItems'],
      ['runOnceForEachItem'],
    ]);
    for (const copy of python) {
      expect(copy.typeOptions?.editorLanguage).toBe('python');
      expect(copy.noDataExpression).toBe(true);
      expect(copy.displayOptions?.show?.language).toEqual(['pythonNative', 'python']);
    }
    for (const copy of copies('jsCode')) {
      expect(copy.displayOptions?.show?.language).toEqual(['javaScript']);
    }
  });

  it('tells the Python author about print, the helpers and imports', () => {
    const notice = properties.find((p) => p.type === 'notice');
    expect(notice?.displayOptions?.show?.language).toEqual(['pythonNative', 'python']);
    expect(notice?.displayName).toContain('print()');
    expect(notice?.displayName).toContain('_items');
    expect(notice?.displayName).toContain('Imports');
  });

  it('finds Python in search', () => {
    expect(CodeNode.description.alias).toEqual(expect.arrayContaining(['python', 'py']));
  });

  it('default code matches what the editor swaps in', async () => {
    const source = readFileSync(new URL('../../editor/src/lib/code-defaults.ts', import.meta.url), 'utf8');
    for (const copy of [...copies('jsCode'), ...copies('pythonCode')]) {
      expect(source).toContain((copy.default as string).replace(/\n/g, '\\n'));
    }
  });

  it('the default Python of both modes runs', async () => {
    const [all, each] = copies('pythonCode');
    const a = await runNode(
      'core.code',
      { language: 'pythonNative', mode: 'runOnceForAllItems', pythonCode: all?.default as string },
      [{ json: { v: 1 } }],
      { services },
    );
    expect(a.outputs[0]).toEqual([{ v: 1, my_new_field: 1 }]);
    const b = await runNode(
      'core.code',
      { language: 'pythonNative', mode: 'runOnceForEachItem', pythonCode: each?.default as string },
      [{ json: { v: 1 } }],
      { services },
    );
    expect(b.outputs[0]).toEqual([{ v: 1, my_new_field: 1 }]);
  });
});

describe('Python Code node', () => {
  const input = [{ json: { v: 2 } }, { json: { v: 5 } }];

  it('transforms items once for all items', async () => {
    const r = await runNode(
      'core.code',
      {
        language: 'pythonNative',
        mode: 'runOnceForAllItems',
        pythonCode: 'return [{"total": sum(i["json"]["v"] for i in _items)}]',
      },
      input,
      { services },
    );
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([{ total: 7 }]);
  });

  it('transforms items once for each item', async () => {
    const r = await runNode(
      'core.code',
      {
        language: 'pythonNative',
        mode: 'runOnceForEachItem',
        pythonCode: '_item["json"]["doubled"] = _item["json"]["v"] * 2\nreturn _item',
      },
      input,
      { services },
    );
    expect(r.outputs[0]).toEqual([
      { v: 2, doubled: 4 },
      { v: 5, doubled: 10 },
    ]);
  });

  it('accepts the stored alias python', async () => {
    const r = await runNode(
      'core.code',
      { language: 'python', mode: 'runOnceForAllItems', pythonCode: 'return {"x": 1}' },
      input,
      { services },
    );
    expect(r.outputs[0]).toEqual([{ x: 1 }]);
  });

  it('keeps JavaScript working with and without a language, and ignores pythonCode there', async () => {
    const parameters = {
      mode: 'runOnceForAllItems',
      jsCode: 'return [{ json: { from: "js" } }]',
      pythonCode: 'return [{"from": "python"}]',
    };
    const without = await runNode('core.code', parameters, input, { services });
    expect(without.outputs[0]).toEqual([{ from: 'js' }]);
    const named = await runNode('core.code', { ...parameters, language: 'javaScript' }, input, { services });
    expect(named.outputs[0]).toEqual([{ from: 'js' }]);
  });

  it('blocks file access and imports, as the node error', async () => {
    const file = await runNode(
      'core.code',
      {
        language: 'pythonNative',
        mode: 'runOnceForAllItems',
        pythonCode: 'return {"x": open("/etc/passwd").read()}',
      },
      input,
      { services },
    );
    expect(file.status).toBe('error');
    expect(file.error?.message).toContain("name 'open' is not defined");

    const network = await runNode(
      'core.code',
      { language: 'pythonNative', mode: 'runOnceForAllItems', pythonCode: 'import socket\nreturn []' },
      input,
      { services },
    );
    expect(network.status).toBe('error');
    expect(network.error?.message).toContain(
      "Import of standard library module 'socket' is disallowed. Allowed stdlib modules: none",
    );
  });

  it('reports the line of a failure', async () => {
    const r = await runNode(
      'core.code',
      { language: 'pythonNative', mode: 'runOnceForAllItems', pythonCode: 'x = 1\nraise ValueError("nope")' },
      input,
      { services },
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('ValueError: nope');
    expect((r.error as { description?: string })?.description).toBe('Error at line 2');
  });

  it('continues on failure when the node says so', async () => {
    const r = await runNode(
      'core.code',
      { language: 'pythonNative', mode: 'runOnceForAllItems', pythonCode: 'return 5' },
      input,
      { services, node: { onError: 'continueRegularOutput' } },
    );
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([{ error: "Code doesn't return items properly" }]);
  });

  it('with no Python runner gives the disabled text', async () => {
    const r = await runNode(
      'core.code',
      { language: 'pythonNative', mode: 'runOnceForAllItems', pythonCode: 'return []' },
      input,
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('PYTHON_ENABLED');
  });
});
