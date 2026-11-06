import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ivm from 'isolated-vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodeRunnerInput } from '../src/engine/services';
import { CodeExecutionError, IsolatedVmCodeRunner } from '../src/sandbox/code-runner';
import { cappedWasmBytes, wasmMemoryMaxPages } from '../src/sandbox/python-assets';
import { ISOLATE_SHIMS, ISOLATE_WASM_GUARD } from '../src/sandbox/python-bootstrap';
import { PyodideCodeRunner, type PyodideRunnerOptions } from '../src/sandbox/python-runner';

const DENY = [
  'eval',
  'exec',
  'compile',
  'open',
  'input',
  'breakpoint',
  'getattr',
  'object',
  'type',
  'vars',
  'setattr',
  'delattr',
  'hasattr',
  'dir',
  'memoryview',
  '__build_class__',
  'globals',
  'locals',
  'license',
  'help',
  'credits',
  'copyright',
];

function make(options: Partial<PyodideRunnerOptions> = {}) {
  return new PyodideCodeRunner({
    memoryLimitMb: 256,
    timeoutMs: 20_000,
    maxConcurrency: 5,
    stdlibAllow: [],
    externalAllow: [],
    builtinsDeny: DENY,
    allowTransitiveImports: false,
    ...options,
  });
}

const base = {
  items: [{ json: { a: 1 } }, { json: { a: 2 } }],
  nodeOutputs: {},
  variables: {},
  workflow: { id: 'w', name: 'W', active: false },
  execution: { id: 'e', mode: 'test' },
  nodeName: 'Code',
  timezone: 'UTC',
};
const all = (code: string, extra: Partial<CodeRunnerInput> = {}): CodeRunnerInput => ({
  ...base,
  code,
  mode: 'runOnceForAllItems',
  language: 'pythonNative',
  ...extra,
});
const each = (code: string, extra: Partial<CodeRunnerInput> = {}): CodeRunnerInput => ({
  ...all(code, extra),
  mode: 'runOnceForEachItem',
});
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('the run should have failed');
    },
    (error: Error) => error,
  );

describe('Python modes', () => {
  const runner = make();

  it('runs once for all items and returns a transformed list', async () => {
    const out = await runner.run(
      all('for item in _items:\n    item["json"]["doubled"] = item["json"]["a"] * 2\nreturn _items'),
    );
    expect(out.map((i) => i.json)).toEqual([
      { a: 1, doubled: 2 },
      { a: 2, doubled: 4 },
    ]);
  });

  it('wraps plain dictionaries in json, and a single dictionary too', async () => {
    const list = await runner.run(all('return [{"x": i["json"]["a"]} for i in _items]'));
    expect(list.map((i) => i.json)).toEqual([{ x: 1 }, { x: 2 }]);
    const one = await runner.run(all('return {"x": len(_items)}'));
    expect(one.map((i) => i.json)).toEqual([{ x: 2 }]);
  });

  it('runs once for each item with _item, pairs items and drops None', async () => {
    const out = await runner.run(
      each('if _item["json"]["a"] == 1:\n    return None\n_item["json"]["seen"] = True\nreturn _item'),
    );
    expect(out).toHaveLength(1);
    expect(out[0].json).toEqual({ a: 2, seen: true });
    expect(out[0].pairedItem).toEqual({ item: 1 });
  });

  it('keeps binary through both modes', async () => {
    const binary = { file: { data: 'aGk=', mimeType: 'text/plain' } };
    const items = [{ json: { a: 1 }, binary }];
    const a = await runner.run(all('return _items', { items }));
    const b = await runner.run(each('return _item', { items }));
    expect(a[0].binary).toEqual(binary);
    expect(b[0].binary).toEqual(binary);
  });

  it('gives no items when all-items code returns nothing', async () => {
    await expect(runner.run(all('x = 1'))).resolves.toEqual([]);
    await expect(runner.run(all(''))).resolves.toEqual([]);
  });

  it('only has the name of its own mode', async () => {
    const a = await failure(runner.run(all('return _item')));
    expect(a).toBeInstanceOf(CodeExecutionError);
    expect((a as Error).message).toContain("NameError: name '_item' is not defined");
    const b = await failure(runner.run(each('return _items')));
    expect((b as Error).message).toContain("NameError: name '_items' is not defined");
  });

  it('has no helpers other than _items and _item', async () => {
    for (const name of ['_input', '_json', '_', '_node', '_now', '_query']) {
      const error = await failure(runner.run(all(`return {"x": ${name}}`)));
      expect((error as Error).message).toContain(`name '${name}' is not defined`);
    }
  });

  it('carries unicode both ways, and values JSON cannot hold', async () => {
    const items = [{ json: { s: 'héllo wörld 你好 😀', n: 1.5 } }];
    const out = await runner.run(
      all(
        'item = _items[0]["json"]\nreturn [{"s": item["s"] + " é😀", "len": len(item["s"]), "nan": float("nan"), "inf": float("inf"), "set": {1}, "n": item["n"], "none": None}]',
        { items },
      ),
    );
    expect(out[0].json).toEqual({
      s: 'héllo wörld 你好 😀 é😀',
      len: 16,
      nan: null,
      inf: null,
      set: '{1}',
      n: 1.5,
      none: null,
    });
  });

  it('keeps multi-line strings and reports the line of the user code', async () => {
    const out = await runner.run(all('text = """a\n  b\nc"""\nreturn {"text": text}'));
    expect(out[0].json).toEqual({ text: 'a\n  b\nc' });
    const error = (await failure(
      runner.run(all('x = 1\ny = 2\nraise ValueError("nope")')),
    )) as CodeExecutionError;
    expect(error.message).toBe('ValueError: nope');
    expect(error.lineNumber).toBe(3);
    const syntax = (await failure(runner.run(all('x = 1\ndef (')))) as CodeExecutionError;
    expect(syntax.message).toContain('SyntaxError');
    expect(syntax.lineNumber).toBe(2);
  });

  it('turns deep recursion into a Python error', async () => {
    const error = await failure(runner.run(all('def f(n):\n    return f(n + 1)\nreturn {"x": f(0)}')));
    expect((error as Error).message).toContain('RecursionError');
  });
});

describe('Python print()', () => {
  const runner = make();

  it('sends print calls to the console with the result', async () => {
    const logs: unknown[][] = [];
    await runner.run(
      all('print("hi", {"x": 1}, [1, 2], 3, None)\nprint()\nreturn []', {
        onConsole: (_level, args) => logs.push(args),
      }),
    );
    expect(logs).toEqual([['hi', '{"x": 1}', '[1, 2]', '3', 'None'], []]);
  });

  it('keeps 100 calls and then a truncated line', async () => {
    const logs: unknown[][] = [];
    await runner.run(
      all('for i in range(130):\n    print(i)\nreturn []', { onConsole: (_level, args) => logs.push(args) }),
    );
    expect(logs).toHaveLength(101);
    expect(logs[99]).toEqual(['99']);
    expect(logs[100]).toEqual(['[Output truncated - 30 more print statements]']);
  });

  it('still sends what was printed when the code fails', async () => {
    const logs: unknown[][] = [];
    await failure(
      runner.run(all('print("before")\nraise ValueError("x")', { onConsole: (_l, args) => logs.push(args) })),
    );
    expect(logs).toEqual([['before']]);
  });
});

describe('Python return rules use the dictionary wording', () => {
  const runner = make();

  it.each([
    ['all items, a number', all('return 5'), "Code doesn't return items properly"],
    ['all items, a list of numbers', all('return [1, 2]'), "Code doesn't return items properly"],
    ['json that is no dictionary', all('return [{"json": 1}]'), "A 'json' property isn't a dictionary"],
    ['an unknown key', all('return [{"json": {}, "extra": 1}]'), 'Unknown top-level item key: extra'],
    ['each item, a number', each('return 5'), "Code doesn't return a dictionary"],
    ['each item, a list', each('return [_item]'), "Code doesn't return a single dictionary"],
    ['each item, json no dictionary', each('return {"json": "x"}'), "A 'json' property isn't a dictionary"],
    [
      'each item, an unknown key',
      each('return {"json": {}, "other": 1}'),
      'Unknown top-level item key: other',
    ],
  ])('%s', async (_name, input, text) => {
    const error = await failure(runner.run(input));
    expect(error).toBeInstanceOf(CodeExecutionError);
    expect((error as Error).message).toBe(text);
  });

  it('accepts the n8n item keys', async () => {
    const out = await runner.run(
      all('return [{"json": {"a": 1}, "pairedItem": {"item": 0}}, {"binary": {}}]'),
    );
    expect(out[0]).toMatchObject({ json: { a: 1 }, pairedItem: { item: 0 } });
    expect(out[1].json).toEqual({});
  });

  it('leaves the JavaScript wording as it was', async () => {
    const js = new IsolatedVmCodeRunner({ timeoutMs: 5000 });
    const error = await failure(js.run({ ...base, code: 'return [1]', mode: 'runOnceForAllItems' }));
    expect((error as Error).message).toContain('Code must return an array of objects, got number');
    const wrapped = await js.run({ ...base, code: 'return [{ json: 1 }]', mode: 'runOnceForAllItems' });
    expect(wrapped[0].json).toEqual({ json: 1 });
  });
});

describe('Python imports', () => {
  const runner = make();

  it('refuses standard library modules that are not allowed, with the n8n text', async () => {
    const error = await failure(runner.run(all('import os\nreturn []')));
    expect((error as Error).message).toBe(
      "Security violations detected:\nLine 1: Import of standard library module 'os' is disallowed. Allowed stdlib modules: none",
    );
    const from = await failure(runner.run(all('x = 1\nfrom json import loads\nreturn []')));
    expect((from as Error).message).toContain(
      "Line 2: Import of standard library module 'json' is disallowed. Allowed stdlib modules: none",
    );
  });

  it.each([
    'js',
    'pyodide',
    'pyodide.ffi',
    'pyodide_js',
    '_pyodide',
    '_pyodide_core',
    'micropip',
    'requests',
  ])('refuses %s with the external text', async (name) => {
    const error = await failure(runner.run(all(`import ${name}\nreturn []`)));
    expect((error as Error).message).toContain(
      `Import of external package '${name.split('.')[0]}' is disallowed. Allowed external packages: none`,
    );
  });

  it('keeps js and pyodide blocked with every list set to all, also by importlib and sys.modules', async () => {
    const open = make({
      stdlibAllow: ['*'],
      externalAllow: ['*'],
      builtinsDeny: [],
      allowTransitiveImports: true,
    });
    for (const name of ['js', 'pyodide', 'micropip']) {
      const error = await failure(open.run(all(`import ${name}\nreturn []`)));
      expect((error as Error).message).toContain(`Import of external package '${name}' is disallowed`);
    }
    const out = await open.run(
      all(`import importlib, sys
found = []
for name in ["js", "pyodide", "pyodide_js", "_pyodide", "micropip"]:
    try:
        importlib.import_module(name)
        found.append(name)
    except ImportError:
        pass
return {"found": found, "left": [m for m in sys.modules if m.split(".")[0] in ("js", "pyodide", "pyodide_js", "_pyodide", "_pyodide_core", "micropip")]}`),
    );
    expect(out[0].json).toEqual({ found: [], left: [] });
  });

  it('refuses relative and dynamic imports', async () => {
    const relative = await failure(runner.run(all('from . import x\nreturn []')));
    expect((relative as Error).message).toContain('Relative imports are disallowed.');
    const dynamic = await failure(runner.run(all('__import__("os")\nreturn []')));
    expect((dynamic as Error).message).toContain(
      'Dynamic __import__() calls are not allowed for security reasons.',
    );
  });

  it('lets an allowed module import, and lists the allowed ones in the text', async () => {
    const allowed = make({ stdlibAllow: ['json', 're'] });
    const out = await allowed.run(
      all('import json\nfrom re import match\nreturn {"x": json.loads("[1]"), "m": bool(match("a", "a"))}'),
    );
    expect(out[0].json).toEqual({ x: [1], m: true });
    const error = await failure(allowed.run(all('import os\nreturn []')));
    expect((error as Error).message).toContain('Allowed stdlib modules: json, re');
  });

  it('without transitive imports an allowed module does not hand out other modules', async () => {
    const strict = make({ stdlibAllow: ['json'] });
    const error = await failure(strict.run(all('import json\nreturn {"x": str(json.codecs)}')));
    expect((error as Error).message).toContain(
      "Import of standard library module 'codecs' is disallowed. Allowed stdlib modules: json",
    );
    // the module's own submodules stay reachable
    const own = await strict.run(
      all(
        'import json\nimport json.decoder as d\nreturn {"x": d.JSONDecoder().decode("1"), "y": json.decoder.JSONDecoder().decode("2")}',
      ),
    );
    expect(own[0].json).toEqual({ x: 1, y: 2 });
    const open = make({ stdlibAllow: ['json'], allowTransitiveImports: true });
    const out = await open.run(all('import json\nreturn {"x": json.codecs.lookup("utf-8").name}'));
    expect(out[0].json).toEqual({ x: 'utf-8' });
  });

  it('guards importlib when it is allowed', async () => {
    const strict = make({ stdlibAllow: ['importlib'] });
    const error = await failure(
      strict.run(all('import importlib\nimportlib.import_module("os")\nreturn []')),
    );
    expect((error as Error).message).toContain("Import of standard library module 'os' is disallowed");
  });

  it.each([
    ['an attribute', 'import importlib\nreturn {"x": str(importlib.machinery.BuiltinImporter)}'],
    ['import as', 'import importlib.machinery as m\nreturn {"x": str(m.BuiltinImporter)}'],
    ['from import', 'from importlib.machinery import BuiltinImporter\nreturn {"x": str(BuiltinImporter)}'],
    [
      'import_module',
      'import importlib\nreturn {"x": str(importlib.import_module("importlib.machinery").BuiltinImporter)}',
    ],
  ])('keeps importlib.machinery out through %s', async (_name, code) => {
    const strict = make({ stdlibAllow: ['importlib'] });
    const error = await failure(strict.run(all(code)));
    expect((error as Error).message).toContain("Import of standard library module 'importlib.machinery");
  });

  it('leaves the parts of importlib that respect the lists', async () => {
    const strict = make({ stdlibAllow: ['importlib', 'json'] });
    const out = await strict.run(
      all(
        'import importlib\nimportlib.invalidate_caches()\nreturn {"x": importlib.import_module("json").loads("1")}',
      ),
    );
    expect(out[0].json).toEqual({ x: 1 });
    const open = make({ stdlibAllow: ['*'] });
    const wide = await open.run(
      all('import importlib\nreturn {"x": importlib.util.find_spec("json") is not None}'),
    );
    expect(wide[0].json).toEqual({ x: true });
  });

  it('a missing attribute of an allowed module holds no real module', async () => {
    const code = (read: string) =>
      `import json\ntry:\n    json.nope\nexcept AttributeError as e:\n    return {"x": ${read}}`;
    const strict = make({ stdlibAllow: ['json'] });
    const error = await failure(strict.run(all(code('str(e.obj)'))));
    expect((error as Error).message).toBe(
      "Security violations detected:\nLine 5: Access to attribute 'obj' is disallowed, because it can be used to bypass security restrictions.",
    );
    const open = make({ stdlibAllow: ['json'], builtinsDeny: [] });
    const out = await open.run(all(code('[str(e), getattr(e, "ob" + "j"), getattr(e, "__con" + "text__")]')));
    expect(out[0].json).toEqual({ x: ["module 'json' has no attribute 'nope'", null, null] });
    const from = await failure(open.run(all('from json import nope\nreturn []')));
    expect((from as Error).message).toContain("ImportError: cannot import name 'nope' from 'json'");
  });

  it('os.path comes with os and hands out no other module', async () => {
    const strict = make({ stdlibAllow: ['os'] });
    const out = await strict.run(
      all(`import os
import os.path as aliased
from os import path
from os.path import join
return {"x": [os.path.join("a", "b"), aliased.join("a", "c"), path.join("a", "d"), join("a", "e")]}`),
    );
    expect(out[0].json).toEqual({ x: ['a/b', 'a/c', 'a/d', 'a/e'] });
    const error = await failure(strict.run(all('import os\nreturn {"x": str(os.path.sys)}')));
    expect((error as Error).message).toContain("Import of standard library module 'sys' is disallowed");
  });
});

describe('Python builtins and the AST validator', () => {
  const runner = make();

  it.each(['open', 'eval', 'exec', 'compile', 'getattr', 'type', 'object', 'globals', 'dir', 'input'])(
    'denies %s',
    async (name) => {
      const error = await failure(runner.run(all(`return {"x": ${name}("x")}`)));
      expect((error as Error).message).toContain(`name '${name}' is not defined`);
    },
  );

  it('denies classes through __build_class__ and follows the deny list', async () => {
    const error = await failure(runner.run(all('class A:\n    pass\nreturn []')));
    expect((error as Error).message).toContain('__build_class__');
    const open = make({ builtinsDeny: ['len'] });
    const out = await open.run(all('class A:\n    pass\nreturn {"x": 1}'));
    expect(out[0].json).toEqual({ x: 1 });
    expect(((await failure(open.run(all('return {"x": len([])}')))) as Error).message).toContain(
      "name 'len' is not defined",
    );
  });

  it.each([
    '__class__',
    '__subclasses__',
    '__dict__',
    '__mro__',
    '__globals__',
    '__code__',
    'f_globals',
    'gi_frame',
    'tb_frame',
    'obj',
    'get_field',
    'vformat',
  ])('blocks attribute %s', async (attr) => {
    const error = await failure(runner.run(all(`x = 1\nreturn {"x": str((1).${attr})}`)));
    expect((error as Error).message).toBe(
      `Security violations detected:\nLine 2: Access to attribute '${attr}' is disallowed, because it can be used to bypass security restrictions.`,
    );
  });

  it.each(['__builtins__', '__globals__', '__loader__', '__spec__', '__name__'])(
    'blocks name %s',
    async (name) => {
      const error = await failure(runner.run(all(`return {"x": str(${name})}`)));
      expect((error as Error).message).toContain(
        `Access to name '${name}' is disallowed, because it can be used to bypass security restrictions.`,
      );
    },
  );

  it('blocks name-mangled access, match patterns, string patterns and bare format', async () => {
    const mangled = await failure(runner.run(all('return {"x": (1).__secret}')));
    expect((mangled as Error).message).toContain('name-mangled');
    const positional = await failure(runner.run(all('match 1:\n    case int(x):\n        pass\nreturn []')));
    expect((positional as Error).message).toContain('Line 2');
    expect((positional as Error).message).toContain('match');
    const keyword = await failure(
      runner.run(all('match 1:\n    case int(__class__=c):\n        pass\nreturn []')),
    );
    expect((keyword as Error).message).toContain("Access to attribute '__class__' is disallowed");
    const text = await failure(runner.run(all('return {"x": "{0.__class__}".format(1)}')));
    expect((text as Error).message).toContain('__class__');
    const fstring = await failure(runner.run(all('y = 1\nreturn {"x": f"__globals__{y}"}')));
    expect((fstring as Error).message).toContain('__globals__');
    const bare = await failure(runner.run(all('f = "{}".format\nreturn {"x": f(1)}')));
    expect((bare as Error).message).toContain("'format'");
    const called = await runner.run(all('return {"x": "{}!".format(1)}'));
    expect(called[0].json).toEqual({ x: '1!' });
    const list = await failure(runner.run(all('import os\nimport sys\nx = (1).__class__')));
    expect((list as Error).message.split('\n')).toHaveLength(4);
  });

  it('refuses string.Formatter reading a field whose name is built at run time', async () => {
    const open = make({ stdlibAllow: ['string'] });
    const error = await failure(
      open.run(
        all(
          'import string\nreturn {"x": str(string.Formatter().get_field("0." + "__cl" + "ass__", (1,), {}))}',
        ),
      ),
    );
    expect((error as Error).message).toContain("Access to attribute 'get_field' is disallowed");
  });
});

describe('Python isolation', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'py-'));
  const file = path.join(dir, 'secret.txt');
  const wide = make({ stdlibAllow: ['*'], builtinsDeny: [], allowTransitiveImports: true });

  beforeAll(() => writeFileSync(file, 'secret'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a host file by its real path gives FileNotFoundError', async () => {
    const error = await failure(wide.run(all(`return {"x": open(${JSON.stringify(file)}).read()}`)));
    expect((error as Error).message).toContain('FileNotFoundError');
    const posix = await failure(wide.run(all('return {"x": open("/etc/passwd").read()}')));
    expect((posix as Error).message).toContain('FileNotFoundError');
    const seen = await wide.run(
      all(`import os
return {"root": sorted(os.listdir("/")), "exists": os.path.exists(${JSON.stringify(file)})}`),
    );
    expect(seen[0].json.exists).toBe(false);
    expect(seen[0].json.root).not.toContain('Users');
    expect(seen[0].json.root).not.toContain('node_modules');
  });

  it('a 127.0.0.1 net.Server sees zero connections', async () => {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      const out = await wide.run(
        all(`import socket, urllib.request
errors = []
try:
    s = socket.socket()
    s.settimeout(2)
    s.connect(("127.0.0.1", ${port}))
    s.send(b"hello")
    s.close()
except Exception as e:
    errors.append("socket")
try:
    urllib.request.urlopen("http://127.0.0.1:${port}/", timeout=2)
except Exception as e:
    errors.append("urllib")
return {"errors": errors}`),
      );
      expect((out[0].json as { errors: string[] }).errors).toContain('urllib');
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(connections).toBe(0);
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('no child can start and the host environment is not there', async () => {
    process.env.PY_TEST_SECRET = 'host-secret';
    try {
      const out = await wide.run(
        all(`import os, subprocess
ran = "no"
try:
    subprocess.run(["echo", "x"])
    ran = "yes"
except Exception:
    pass
return {"ran": ran, "env": dict(os.environ)}`),
      );
      expect(out[0].json).toEqual({ ran: 'no', env: {} });
    } finally {
      delete process.env.PY_TEST_SECRET;
    }
  });

  it('runs share nothing: each has its own interpreter', async () => {
    const open = make({ stdlibAllow: ['builtins'], builtinsDeny: [], allowTransitiveImports: true });
    await open.run(all('import builtins\nbuiltins.leak = 1\nglobal shared\nshared = 1\nreturn []'));
    const out = await open.run(
      all('import builtins\nreturn {"leak": hasattr(builtins, "leak"), "shared": "shared" in globals()}'),
    );
    expect(out[0].json).toEqual({ leak: false, shared: false });
  });

  async function shimmed<T>(use: (context: ivm.Context) => Promise<T>): Promise<T> {
    const isolate = new ivm.Isolate({ memoryLimit: 32 });
    try {
      const context = await isolate.createContext();
      await context.global.set('globalThis', context.global.derefInto());
      await context.global.set('__asset', new ivm.Callback(() => undefined));
      await context.global.set('__random', new ivm.Callback(() => undefined));
      await context.eval(ISOLATE_SHIMS);
      return await use(context);
    } finally {
      isolate.dispose();
    }
  }

  it('the isolate shims hold no host object and no way out', async () => {
    const names = await shimmed(async (context) =>
      JSON.parse((await context.eval('JSON.stringify(Object.getOwnPropertyNames(globalThis))')) as string),
    );
    for (const name of [
      'process',
      'require',
      'module',
      'fetch',
      'XMLHttpRequest',
      'WebSocket',
      'Buffer',
      '__asset',
      '__random',
    ]) {
      expect(names).not.toContain(name);
    }
    for (const name of [
      'setTimeout',
      'clearTimeout',
      'performance',
      'TextEncoder',
      'TextDecoder',
      'crypto',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('the text shims encode and decode as the platform does', async () => {
    const text = 'aé你😀';
    const out = await shimmed(async (context) =>
      JSON.parse(
        (await context.eval(`JSON.stringify((() => {
          const e = new TextEncoder().encode(${JSON.stringify(text)});
          const into = new Uint8Array(4);
          const partial = new TextEncoder().encodeInto(${JSON.stringify(text)}, into);
          const bad = new Uint8Array([0x61, 0xff, 0x62]);
          let fatal = false;
          try { new TextDecoder('utf-8', { fatal: true }).decode(bad); } catch { fatal = true; }
          return {
            bytes: Array.from(e),
            back: new TextDecoder().decode(e),
            partial,
            loose: new TextDecoder('utf8').decode(bad),
            fatal,
            latin1: new TextDecoder('latin1').decode(new Uint8Array([0xe9])),
            utf16: new TextDecoder('utf-16le').decode(new Uint8Array([0x3d, 0xd8, 0x00, 0xde])),
            empty: new TextDecoder().decode(),
          };
        })())`)) as string,
      ),
    );
    expect(out.bytes).toEqual(Array.from(Buffer.from(text)));
    expect(out.back).toBe(text);
    expect(out.partial).toEqual({ read: 2, written: 3 });
    expect(out.loose).toBe('a\ufffdb');
    expect(out.fatal).toBe(true);
    expect(out.latin1).toBe('é');
    expect(out.utf16).toBe('😀');
    expect(out.empty).toBe('');
  });

  it('gets real random bytes from the host callback', async () => {
    const open = make({ stdlibAllow: ['os'] });
    const a = await open.run(all('import os\nreturn {"x": os.urandom(70000).hex()}'));
    const b = await open.run(all('import os\nreturn {"x": os.urandom(32).hex()}'));
    expect((a[0].json.x as string).length).toBe(140000);
    expect((a[0].json.x as string).slice(0, 64)).not.toBe(b[0].json.x);
  });

  it('random gives other numbers in every run', async () => {
    const code = 'import random\nreturn {"x": [random.random(), random.randint(0, 10 ** 9)]}';
    const a = await make({ stdlibAllow: ['random'] }).run(all(code));
    const b = await make({ stdlibAllow: ['random'] }).run(all(code));
    expect(a[0].json.x).not.toEqual(b[0].json.x);
  });

  it('leaves nothing of Pyodide in __main__ or on sys.meta_path, with every list set to all', async () => {
    const out = await wide.run(
      all(`import sys
return {"core": "_pyodide_core" in vars(sys.modules["__main__"]), "finders": [repr(f) for f in sys.meta_path if "pyodide" in repr(f)]}`),
    );
    expect(out[0].json).toEqual({ core: false, finders: [] });
  });

  /** ctypes, when an admin allows it, is a way from Python into the isolate's JavaScript */
  const inJs = (script: string) =>
    `import ctypes\nreturn {"x": ctypes.CDLL(None).emscripten_run_script_int(b${JSON.stringify(script)})}`;

  it('code that reaches the JavaScript cannot pass the cap with a new wasm memory', async () => {
    const open = make({ stdlibAllow: ['ctypes'], memoryLimitMb: 128 });
    const text = 'Code exceeded the memory limit of 128MB';
    const memory = await failure(
      open.run(
        all(
          inJs(
            '(()=>{const m=new WebAssembly.Memory({initial:16384});const u=new Uint8Array(m.buffer);for(let i=0;i<u.length;i+=65536)u[i]=1;return u.length/1048576})()',
          ),
        ),
      ),
    );
    expect((memory as Error).message).toBe(text);
    const owned = await failure(
      open.run(
        all(
          inJs(
            '(()=>{const m=new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0,5,4,1,0,128,2]));new WebAssembly.Instance(m);return 1})()',
          ),
        ),
      ),
    );
    expect((owned as Error).message).toBe(text);
  });

  it('the wasm guard refuses a new memory for good and lets a module without one compile', async () => {
    const out = await shimmed(async (context) => {
      await context.eval('globalThis.older = new WebAssembly.Memory({ initial: 1 })');
      await context.global.set('__compileLimit', 4096);
      await context.eval(ISOLATE_WASM_GUARD);
      return JSON.parse(
        (await context.eval(
          `(async () => {
            const header = [0, 97, 115, 109, 1, 0, 0, 0];
            const plain = new Uint8Array(header);
            const withMemory = new Uint8Array([...header, 0, 2, 1, 97, 5, 3, 1, 0, 1]);
            const refused = (work) => {
              try {
                work();
                return false;
              } catch (error) {
                return /memory limit/.test(error.message);
              }
            };
            const lying = new Uint8Array(withMemory);
            Object.defineProperty(lying, 'buffer', { value: plain.buffer });
            Object.defineProperty(lying, 'byteLength', { value: 8 });
            const module = new WebAssembly.Module(plain);
            const instance = new WebAssembly.Instance(module);
            const compiled = await WebAssembly.compile(plain);
            const instantiated = await WebAssembly.instantiate(plain);
            const out = {
              limitGone: !('__compileLimit' in globalThis),
              memory: refused(() => new WebAssembly.Memory({ initial: 1 })),
              memoryCall: refused(() => WebAssembly.Memory({ initial: 1 })),
              noMemoryConstructor: older.constructor === Object && !refused(() => new older.constructor()),
              noModuleConstructor: module.constructor === Object && instance instanceof WebAssembly.Instance,
              isModule: module instanceof WebAssembly.Module && compiled instanceof WebAssembly.Module,
              olderIsMemory: older instanceof WebAssembly.Memory,
              instantiated: instantiated.instance instanceof WebAssembly.Instance,
              exports: Array.isArray(WebAssembly.Module.exports(module)),
              imports: Array.isArray(WebAssembly.Module.imports(module)),
              sections: WebAssembly.Module.customSections(module, 'x').length,
              withMemory: refused(() => new WebAssembly.Module(withMemory)),
              withMemoryBuffer: refused(() => new WebAssembly.Module(withMemory.buffer)),
              lying: refused(() => new WebAssembly.Module(lying)),
              compile: await WebAssembly.compile(withMemory).then(() => 'compiled', (error) => error.message),
              instantiate: await WebAssembly.instantiate(withMemory).then(() => 'made', (error) => error.message),
            };
            Object.defineProperty(Object.getPrototypeOf(Uint8Array.prototype), 'length', { get: () => 0 });
            out.lengthGetter = refused(() => new WebAssembly.Module(withMemory));
            const big = new Uint8Array(5000);
            big.set([...header, 0, 0xfd, 0x26, 1, 97]);
            out.total = refused(() => new WebAssembly.Module(big));
            return JSON.stringify(out);
          })()`,
          { promise: true },
        )) as string,
      );
    });
    expect(out).toEqual({
      limitGone: true,
      memory: true,
      memoryCall: true,
      noMemoryConstructor: true,
      noModuleConstructor: true,
      isModule: true,
      olderIsMemory: true,
      instantiated: true,
      exports: true,
      imports: true,
      sections: 0,
      withMemory: true,
      withMemoryBuffer: true,
      lying: true,
      compile: 'Code exceeded the memory limit',
      instantiate: 'Code exceeded the memory limit',
      lengthGetter: true,
      total: true,
    });
  });
});

describe('Python limits', () => {
  it('kills while True at the timeout and the next run works', async () => {
    const runner = make({ timeoutMs: 1000 });
    const started = Date.now();
    const error = await failure(runner.run(all('while True:\n    pass')));
    expect(error).toBeInstanceOf(CodeExecutionError);
    expect((error as Error).message).toBe('Code execution timed out after 1000ms');
    expect(Date.now() - started).toBeLessThan(30_000);
    const big = await failure(runner.run(all('x = 10 ** 10000000\ny = x * x * x\nreturn []')));
    expect((big as Error).message).toBe('Code execution timed out after 1000ms');
    await expect(make().run(all('return {"x": 1}'))).resolves.toHaveLength(1);
  });

  it('stops at the memory cap: one big block and slow growth, the host stays small', async () => {
    const runner = make({ memoryLimitMb: 96 });
    const text = 'Code exceeded the memory limit of 96MB';
    const before = process.memoryUsage().rss;
    const big = await failure(runner.run(all('x = bytearray(1500 * 1024 * 1024)\nreturn [{"n": len(x)}]')));
    expect((big as Error).message).toBe(text);
    const slow = await failure(
      runner.run(all('kept = []\nwhile True:\n    kept.append(bytearray(4 * 1024 * 1024))\nreturn []')),
    );
    expect((slow as Error).message).toBe(text);
    expect(process.memoryUsage().rss - before).toBeLessThan(800 * 1024 * 1024);
    // under the cap works
    const fits = await runner.run(all('x = bytearray(20 * 1024 * 1024)\nreturn [{"n": len(x)}]'));
    expect(fits[0].json).toEqual({ n: 20 * 1024 * 1024 });
  });

  it('runs 200 MB under the decided 256 MB cap', async () => {
    const out = await make().run(all('x = bytearray(200 * 1024 * 1024)\nreturn [{"n": len(x)}]'));
    expect(out[0].json).toEqual({ n: 200 * 1024 * 1024 });
  });

  it('patches the memory maximum of the wasm and leaves the rest of it', () => {
    expect(wasmMemoryMaxPages(cappedWasmBytes(256))).toBe(4096);
    expect(wasmMemoryMaxPages(cappedWasmBytes(64))).toBe(1024);
    expect(() => wasmMemoryMaxPages(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))).toThrow();
  });

  it('refuses input over the payload cap', async () => {
    const items = [{ json: { s: 'x'.repeat(65 * 1024 * 1024) } }];
    const error = await failure(make().run(all('return []', { items })));
    expect((error as Error).message).toBe('Input data is too large for the Code node sandbox');
  });

  it('runs at most maxConcurrency at once, in order', async () => {
    const runner = make({ maxConcurrency: 1, timeoutMs: 1500 });
    const order: string[] = [];
    const first = runner.run(all('while True:\n    pass')).catch(() => order.push('first'));
    const second = runner.run(all('return {"x": 2}')).then(() => order.push('second'));
    const third = runner.run(all('return {"x": 3}')).then(() => order.push('third'));
    await Promise.all([first, second, third]);
    expect(order).toEqual(['first', 'second', 'third']);
    const many = make({ maxConcurrency: 2 });
    const out = await Promise.all([1, 2, 3, 4].map((n) => many.run(all(`return {"x": ${n}}`))));
    expect(out.map((r) => r[0].json.x)).toEqual([1, 2, 3, 4]);
  });

  it('cancels on the abort signal, running or still waiting', async () => {
    const runner = make({ maxConcurrency: 1 });
    const controller = new AbortController();
    const running = failure(runner.run(all('while True:\n    pass', { signal: controller.signal })));
    const waiting = failure(runner.run(all('return []', { signal: controller.signal })));
    setTimeout(() => controller.abort(), 2500);
    expect(((await running) as Error).message).toBe('Code execution was cancelled');
    expect(((await waiting) as Error).message).toBe('Code execution was cancelled');
    const already = failure(runner.run(all('return []', { signal: controller.signal })));
    expect(((await already) as Error).message).toBe('Code execution was cancelled');
    await expect(runner.run(all('return {"x": 1}'))).resolves.toHaveLength(1);
  });
});
