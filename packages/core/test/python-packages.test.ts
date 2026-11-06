/**
 * P4-20: extra Python packages. Every wheel is built here in a temp folder; nothing is downloaded.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import type { CodeRunnerInput } from '../src/engine/services';
import { CodeExecutionError } from '../src/sandbox/code-runner';
import { pythonAssetLoader, readWheelFolder } from '../src/sandbox/python-assets';
import { PyodideCodeRunner, type PyodideRunnerOptions } from '../src/sandbox/python-runner';

/** a zip the way a wheel is one: deflated entries, a central directory, an end record */
function zip(files: Record<string, string | Buffer>): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let at = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content);
    const packed = deflateRawSync(raw, { level: 1 });
    const nameBytes = Buffer.from(name);
    const fields = Buffer.alloc(26);
    fields.writeUInt16LE(20, 0);
    fields.writeUInt16LE(8, 4);
    fields.writeUInt32LE(crc32(raw), 10);
    fields.writeUInt32LE(packed.length, 14);
    fields.writeUInt32LE(raw.length, 18);
    fields.writeUInt16LE(nameBytes.length, 22);
    const head = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), fields, nameBytes]);
    parts.push(head, packed);
    const tail = Buffer.alloc(14);
    tail.writeUInt32LE(at, 10);
    directory.push(Buffer.concat([Buffer.from([0x50, 0x4b, 1, 2, 20, 0]), fields, tail, nameBytes]));
    at += head.length + packed.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(directory.length, 8);
  end.writeUInt16LE(directory.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([...parts, central, end]);
}

const folders: string[] = [];
function folder(wheels: Record<string, Record<string, string | Buffer> | Buffer>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'wheels-'));
  folders.push(dir);
  for (const [file, content] of Object.entries(wheels)) {
    writeFileSync(path.join(dir, file), Buffer.isBuffer(content) ? content : zip(content));
  }
  return dir;
}
afterAll(() => {
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
});

const info = (dist: string) => ({ [`${dist}.dist-info/METADATA`]: `Name: ${dist}\n` });

function make(options: Partial<PyodideRunnerOptions> = {}) {
  return new PyodideCodeRunner({
    memoryLimitMb: 128,
    timeoutMs: 20_000,
    maxConcurrency: 5,
    stdlibAllow: [],
    externalAllow: [],
    builtinsDeny: ['eval', 'exec', 'compile', 'open', 'input', 'getattr', 'object', 'type', 'vars', 'dir', 'globals'],
    allowTransitiveImports: false,
    ...options,
  });
}

const input = (code: string, extra: Partial<CodeRunnerInput> = {}): CodeRunnerInput => ({
  items: [{ json: { a: 1 } }],
  nodeOutputs: {},
  variables: {},
  workflow: { id: 'w', name: 'W', active: false },
  execution: { id: 'e', mode: 'test' },
  nodeName: 'Code',
  timezone: 'UTC',
  code,
  mode: 'runOnceForAllItems',
  language: 'pythonNative',
  ...extra,
});
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('the run should have failed');
    },
    (error: Error) => error,
  );
const value = async (runner: PyodideCodeRunner, code: string) =>
  (await runner.run(input(`${code}\nreturn [{"json": {"v": out}}]`)))[0]?.json.v;

const tiny = {
  'tiny-1.0-py3-none-any.whl': { 'tiny/__init__.py': 'VALUE = 41\ndef add(n):\n    return VALUE + n\n', ...info('tiny-1.0') },
};

describe('an allowed package', () => {
  it('imports from a pure-Python wheel and its code runs', async () => {
    const runner = make({ externalAllow: ['tiny'], wheelsDir: folder(tiny) });
    expect(await value(runner, 'import tiny\nout = tiny.add(1)')).toBe(42);
  });

  it('imports with from, as, and a submodule', async () => {
    const dir = folder({
      'tiny-1.0-py3-none-any.whl': {
        'tiny/__init__.py': 'VALUE = 1\n',
        'tiny/sub/__init__.py': '',
        'tiny/sub/deep.py': 'WORD = "deep"\n',
        ...info('tiny-1.0'),
      },
    });
    const runner = make({ externalAllow: ['tiny'], wheelsDir: dir });
    expect(await value(runner, 'from tiny.sub.deep import WORD\nout = WORD')).toBe('deep');
    expect(await value(runner, 'import tiny.sub.deep as d\nout = d.WORD')).toBe('deep');
    expect(await value(runner, 'import tiny.sub.deep\nout = tiny.sub.deep.WORD')).toBe('deep');
    expect(await value(runner, 'from tiny import VALUE\nout = VALUE')).toBe(1);
  });

  it('imports a wheel holding one module file', async () => {
    const dir = folder({ 'solo-2.0-py2.py3-none-any.whl': { 'solo.py': 'WORD = "solo"\n', ...info('solo-2.0') } });
    expect(await value(make({ externalAllow: ['solo'], wheelsDir: dir }), 'import solo\nout = solo.WORD')).toBe('solo');
  });

  it('goes by the import name, not the name of the wheel', async () => {
    const dir = folder({
      'python_dateish-1.0-py3-none-any.whl': { 'dateish/__init__.py': 'WORD = "d"\n', ...info('python_dateish-1.0') },
    });
    expect(await value(make({ externalAllow: ['dateish'], wheelsDir: dir }), 'import dateish\nout = dateish.WORD')).toBe('d');
    const error = await failure(make({ externalAllow: ['python_dateish'], wheelsDir: dir }).run(input('import dateish')));
    expect(error.message).toContain("Import of external package 'dateish' is disallowed");
  });

  it('works in each-item mode and in the Code tool', async () => {
    const runner = make({ externalAllow: ['tiny'], wheelsDir: folder(tiny) });
    const items = await runner.run(
      input('import tiny\nreturn {"json": {"v": tiny.add(_item["json"]["a"])}}', { mode: 'runOnceForEachItem' }),
    );
    expect(items.map((i) => i.json.v)).toEqual([42]);
    const tool = await runner.run(input('import tiny\nreturn tiny.add(len(_query))', { query: 'abc' }));
    expect(tool[0]?.json.result).toBe(44);
  });

  it('gets its own imports from the folder, without opening them to user code', async () => {
    const dir = folder({
      'tiny-1.0-py3-none-any.whl': { 'tiny/__init__.py': 'import helper\nVALUE = helper.WORD\n', ...info('tiny-1.0') },
      'helper-1.0-py3-none-any.whl': { 'helper/__init__.py': 'WORD = "helped"\n', ...info('helper-1.0') },
    });
    const runner = make({ externalAllow: ['tiny'], wheelsDir: dir });
    expect(await value(runner, 'import tiny\nout = tiny.VALUE')).toBe('helped');
    const direct = await failure(runner.run(input('import helper')));
    expect(direct.message).toContain("Import of external package 'helper' is disallowed. Allowed external packages: tiny");
    const through = await failure(runner.run(input('import tiny\nreturn [{"json": {"v": tiny.helper.WORD}}]')));
    expect(through.message).toContain("Import of external package 'helper' is disallowed");
  });

  it('joins two wheels that share a namespace package', async () => {
    const dir = folder({
      'ns_one-1.0-py3-none-any.whl': { 'ns/one/__init__.py': 'WORD = "one"\n', ...info('ns_one-1.0') },
      'ns_two-1.0-py3-none-any.whl': { 'ns/two/__init__.py': 'WORD = "two"\n', ...info('ns_two-1.0') },
    });
    const runner = make({ externalAllow: ['ns'], wheelsDir: dir });
    expect(await value(runner, 'import ns.one, ns.two\nout = ns.one.WORD + ns.two.WORD')).toBe('onetwo');
  });

  it('takes the highest version when a folder holds two', async () => {
    const dir = folder({
      'tiny-1.2-py3-none-any.whl': { 'tiny/__init__.py': 'VALUE = "1.2"\n', ...info('tiny-1.2') },
      'tiny-1.10-py3-none-any.whl': { 'tiny/__init__.py': 'VALUE = "1.10"\n', ...info('tiny-1.10') },
    });
    expect(await value(make({ externalAllow: ['tiny'], wheelsDir: dir }), 'import tiny\nout = tiny.VALUE')).toBe('1.10');
  });

  it('allows every wheel in the folder with *', async () => {
    const runner = make({ externalAllow: ['*'], wheelsDir: folder(tiny) });
    expect(await value(runner, 'import tiny\nout = tiny.VALUE')).toBe(41);
    const error = await failure(runner.run(input('import nothere')));
    expect(error.message).toContain("No module named 'nothere'");
  });

  it('gives no state from one run to the next', async () => {
    const dir = folder({
      'tiny-1.0-py3-none-any.whl': {
        'tiny/__init__.py': 'SEEN = []\ndef note():\n    SEEN.append(1)\n    return len(SEEN)\n',
        ...info('tiny-1.0'),
      },
    });
    const runner = make({ externalAllow: ['tiny'], wheelsDir: dir });
    expect(await value(runner, 'import tiny\nout = tiny.note()')).toBe(1);
    expect(await value(runner, 'import tiny\nout = tiny.note()')).toBe(1);
  });
});

describe('a Pyodide wheel', () => {
  const abiTag = 'pyemscripten_2026_0_wasm32';
  const leb = (n: number): number[] => {
    const out: number[] = [];
    let rest = n;
    do {
      const low = rest & 0x7f;
      rest >>>= 7;
      out.push(rest ? low | 0x80 : low);
    } while (rest);
    return out;
  };
  const text = (s: string) => [...leb(Buffer.byteLength(s)), ...Buffer.from(s)];
  const section = (id: number, body: number[]) => [id, ...leb(body.length), ...body];

  /**
   * A real extension module by hand, since no compiler is here: a side module that calls
   * PyModule_Create2 on a PyModuleDef in its own data (wasm32: m_name at 20, m_size at 28).
   */
  function extensionModule(): Buffer {
    const name = 'tinyc._native';
    const init = 'PyInit__native';
    const TEXT_AT = 64;
    const dylinkInfo = [1, ...((b) => [...leb(b.length), ...b])([...leb(128), 4, 0, 0])];
    const body = [
      0, // no locals
      0x23, 0, 0x23, 0, 0x41, ...sleb(TEXT_AT), 0x6a, 0x36, 2, 20, // def.m_name = base + TEXT_AT
      0x23, 0, 0x41, 0x7f, 0x36, 2, 28, // def.m_size = -1
      0x23, 0, 0x41, ...sleb(1013), 0x10, 0, // PyModule_Create2(def, PYTHON_API_VERSION)
      0x0b,
    ];
    const data = [...Array(TEXT_AT).fill(0), ...Buffer.from(name), 0];
    data[0] = 1; // ob_refcnt
    return Buffer.from([
      0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
      ...section(0, [...text('dylink.0'), ...dylinkInfo]),
      ...section(1, [2, 0x60, 0, 1, 0x7f, 0x60, 2, 0x7f, 0x7f, 1, 0x7f]),
      ...section(2, [
        3,
        ...text('env'), ...text('memory'), 2, 0, 1,
        ...text('env'), ...text('__memory_base'), 3, 0x7f, 0,
        ...text('env'), ...text('PyModule_Create2'), 0, 1,
      ]),
      ...section(3, [1, 0]),
      ...section(7, [1, ...text(init), 0, 1]),
      ...section(10, [1, ...leb(body.length), ...body]),
      ...section(11, [1, 0, 0x23, 0, 0x0b, ...leb(data.length), ...data]),
    ]);
  }
  function sleb(n: number): number[] {
    const out: number[] = [];
    let rest = n;
    for (;;) {
      const low = rest & 0x7f;
      rest >>= 7;
      if ((rest === 0 && !(low & 0x40)) || (rest === -1 && low & 0x40)) {
        out.push(low);
        return out;
      }
      out.push(low | 0x80);
    }
  }

  it('loads a compiled extension module from a wheel with this Pyodide tag', async () => {
    const dir = folder({
      [`tinyc-1.0-cp314-cp314-${abiTag}.whl`]: {
        'tinyc/__init__.py': 'from . import _native\nNAME = _native.__name__\nWHERE = _native.__file__\n',
        'tinyc/_native.cpython-314-wasm32-emscripten.so': extensionModule(),
        ...info('tinyc-1.0'),
      },
    });
    const runner = make({ externalAllow: ['tinyc'], wheelsDir: dir });
    expect(await value(runner, 'import tinyc\nout = [tinyc.NAME, tinyc.WHERE]')).toEqual([
      'tinyc._native',
      '/lib/wheels/tinyc/_native.cpython-314-wasm32-emscripten.so',
    ]);
  });

  it('refuses a wheel of another Pyodide version, and one for Linux, with a clear text', async () => {
    const native = { 'nat/__init__.py': 'VALUE = 1\n', ...info('nat-1.0') };
    for (const tag of ['cp314-cp314-manylinux_2_17_x86_64', 'cp313-cp313-pyemscripten_2025_0_wasm32', 'py2-none-any']) {
      const file = `nat-1.0-${tag}.whl`;
      const runner = make({ externalAllow: ['nat'], wheelsDir: folder({ [file]: native }) });
      const error = await failure(runner.run(input('import nat')));
      expect(error.message).toContain(`Wheel '${file}' cannot run in the Python sandbox`);
      expect(error.message).not.toContain(tmpdir());
    }
  });

  it('prefers a wheel that can run to one that cannot', async () => {
    const dir = folder({
      'nat-2.0-cp314-cp314-manylinux_2_17_x86_64.whl': { 'nat/__init__.py': 'VALUE = "linux"\n', ...info('nat-2.0') },
      'nat-1.0-py3-none-any.whl': { 'nat/__init__.py': 'VALUE = "pure"\n', ...info('nat-1.0') },
    });
    expect(await value(make({ externalAllow: ['nat'], wheelsDir: dir }), 'import nat\nout = nat.VALUE')).toBe('pure');
  });

  it('reads the tag of this Pyodide from its lock file', () => {
    const dir = folder({
      [`one-1.0-cp314-cp314-${abiTag}.whl`]: { 'one/__init__.py': '', ...info('one-1.0') },
      [`two-1.0-cp312-abi3-${abiTag}.whl`]: { 'two/__init__.py': '', ...info('two-1.0') },
      'three-1.0-cp314-cp314-pyemscripten_2025_0_wasm32.whl': { 'three/__init__.py': '', ...info('three-1.0') },
    });
    const wheels = readWheelFolder(dir);
    expect([...wheels.roots.keys()].sort()).toEqual(['one', 'two']);
    expect([...wheels.unusable.keys()]).toEqual(['three']);
  });
});

describe('a package that is not allowed', () => {
  it("is refused with n8n's text, even with its wheel in the folder", async () => {
    const dir = folder(tiny);
    const none = await failure(make({ wheelsDir: dir }).run(input('import tiny')));
    expect(none.message).toContain("Line 1: Import of external package 'tiny' is disallowed. Allowed external packages: none");
    const other = await failure(make({ externalAllow: ['other', 'more'], wheelsDir: dir }).run(input('from tiny import VALUE')));
    expect(other.message).toContain("Import of external package 'tiny' is disallowed. Allowed external packages: more, other");
  });

  it('stays refused with importlib allowed', async () => {
    const runner = make({ externalAllow: ['other'], stdlibAllow: ['importlib'], wheelsDir: folder(tiny) });
    const error = await failure(runner.run(input('import importlib\nimportlib.import_module("tiny")')));
    expect(error.message).toContain("Import of external package 'tiny' is disallowed");
  });

  it('gives an allowed name with no wheel the plain Python text', async () => {
    const error = await failure(make({ externalAllow: ['gone'], wheelsDir: folder(tiny) }).run(input('import gone')));
    expect(error.message).toContain("No module named 'gone'");
  });

  it('cannot bring back js, pyodide or micropip with a wheel of that name', async () => {
    const dir = folder({
      'micropip-0.11.1-py3-none-any.whl': { 'micropip/__init__.py': 'VALUE = 1\n', ...info('micropip-0.11.1') },
      'js-1.0-py3-none-any.whl': { 'js/__init__.py': 'VALUE = 1\n', ...info('js-1.0') },
      'pyodide_http-1.0-py3-none-any.whl': { 'pyodide_http/__init__.py': 'VALUE = 1\n', ...info('pyodide_http-1.0') },
      'sneaky-1.0-py3-none-any.whl': {
        'sneaky/__init__.py': 'import js\n',
        ...info('sneaky-1.0'),
      },
    });
    const runner = make({ externalAllow: ['*', 'micropip', 'js'], wheelsDir: dir });
    for (const name of ['micropip', 'js', 'pyodide_http']) {
      const error = await failure(runner.run(input(`import ${name}`)));
      expect(error.message).toContain(`Import of external package '${name}' is disallowed`);
    }
    const error = await failure(runner.run(input('import sneaky')));
    expect(error.message).toContain("No module named 'js'");
  });
});

describe('the sandbox with wheels', () => {
  it('leaves wheel code in the isolate: no host file, no environment, no socket', async () => {
    const hostFile = path.join(mkdtempSync(path.join(tmpdir(), 'host-')), 'secret.txt');
    folders.push(path.dirname(hostFile));
    writeFileSync(hostFile, 'secret');
    const probe = [
      'import os, socket',
      'def host_file(name):',
      '    try:',
      '        return open(name).read()',
      '    except OSError as error:',
      '        return type(error).__name__',
      'def env():',
      '    return dict(os.environ)',
      'def connect():',
      '    try:',
      '        socket.create_connection(("127.0.0.1", 9), 1)',
      '        return "connected"',
      '    except OSError as error:',
      '        return type(error).__name__',
    ].join('\n');
    const dir = folder({ 'probe-1.0-py3-none-any.whl': { 'probe/__init__.py': probe, ...info('probe-1.0') } });
    const runner = make({ externalAllow: ['probe'], wheelsDir: dir });
    const out = await value(
      runner,
      `import probe\nout = [probe.host_file(${JSON.stringify(hostFile.replaceAll('\\', '/'))}), probe.env(), probe.connect()]`,
    );
    const [file, env, connect] = out as [string, object, string];
    expect(file).toBe('FileNotFoundError');
    expect(env).toEqual({});
    expect(connect).not.toBe('connected');
  });

  it('lets wheel code use only its own bytes: the fetch has no prototype, throws nothing, refuses other names', async () => {
    const probe = [
      'import sys',
      'def fetch():',
      '    seen = []',
      '    todo = list(sys.meta_path)',
      '    while todo:',
      '        now = todo.pop()',
      '        if id(now) in seen:',
      '            continue',
      '        seen.append(id(now))',
      '        if type(now).__name__.startswith("Js"):',
      '            return now',
      '        if isinstance(now, type):',
      '            todo.extend(vars(now).values())',
      '        now = getattr(now, "__func__", now)',
      '        for cell in getattr(now, "__closure__", None) or ():',
      '            todo.append(cell.cell_contents)',
      '    return None',
      'def report():',
      '    found = fetch()',
      '    return {',
      '        "found": found is not None,',
      '        "reach": [name for name in ("constructor", "__proto__", "prototype", "call", "apply", "bind") if hasattr(found, name)],',
      '        "outside": found("../../../secret.txt"),',
      '        "other": found("other.whl"),',
      '    }',
    ].join('\n');
    const dir = folder({ 'probe-1.0-py3-none-any.whl': { 'probe/__init__.py': probe, ...info('probe-1.0') } });
    writeFileSync(path.join(dir, 'secret.txt'), 'secret');
    const out = await value(make({ externalAllow: ['probe'], wheelsDir: dir }), 'import probe\nout = probe.report()');
    expect(out).toEqual({ found: true, reach: [], outside: false, other: false });
  });

  it('keeps js and pyodide out of sys.modules for wheel code', async () => {
    const probe = 'import sys\nJS = "js" in sys.modules\nPYO = "pyodide" in sys.modules or "_pyodide" in sys.modules\n';
    const dir = folder({ 'probe-1.0-py3-none-any.whl': { 'probe/__init__.py': probe, ...info('probe-1.0') } });
    const out = await value(make({ externalAllow: ['probe'], wheelsDir: dir }), 'import probe\nout = [probe.JS, probe.PYO]');
    expect(out).toEqual([false, false]);
  });

  it('unpacks only inside the wheel folder of the in-memory file system', async () => {
    const probe = 'import os\nLOOSE = os.path.exists("/evil.py") or os.path.exists("/lib/evil.py")\nFILE = __file__\n';
    const dir = folder({
      'tiny-1.0-py3-none-any.whl': { 'tiny/__init__.py': probe, '../../evil.py': 'BAD = 1\n', ...info('tiny-1.0') },
    });
    const out = await value(make({ externalAllow: ['tiny'], wheelsDir: dir }), 'import tiny\nout = [tiny.LOOSE, tiny.FILE]');
    expect(out).toEqual([false, '/lib/wheels/tiny/__init__.py']);
  });

  it('keeps the standard library ahead of a wheel with the same name', async () => {
    const dir = folder({ 'fake-1.0-py3-none-any.whl': { 'textwrap.py': 'WORD = "fake"\n', ...info('fake-1.0') } });
    const runner = make({ externalAllow: ['textwrap'], stdlibAllow: ['textwrap'], wheelsDir: dir });
    expect(await value(runner, 'import textwrap\nout = textwrap.fill("a b", 80)')).toBe('a b');
  });

  it('stops a wheel that loops while it imports, and the next run works', async () => {
    const dir = folder({
      'spin-1.0-py3-none-any.whl': { 'spin/__init__.py': 'while True:\n    pass\n', ...info('spin-1.0') },
      ...tiny,
    });
    const runner = make({ externalAllow: ['spin', 'tiny'], wheelsDir: dir, timeoutMs: 1500 });
    const error = await failure(runner.run(input('import spin')));
    expect(error).toBeInstanceOf(CodeExecutionError);
    expect(error.message).toBe('Code execution timed out after 1500ms');
    expect(await value(runner, 'import tiny\nout = tiny.VALUE')).toBe(41);
  });

  it('stops a wheel too big to unpack at the memory limit, and the next run works', async () => {
    const dir = folder({
      'huge-1.0-py3-none-any.whl': { 'huge/__init__.py': '', 'huge/blob.bin': Buffer.alloc(400 * 1024 * 1024), ...info('huge-1.0') },
      ...tiny,
    });
    const runner = make({ externalAllow: ['huge', 'tiny'], wheelsDir: dir, memoryLimitMb: 128 });
    const error = await failure(runner.run(input('import huge')));
    expect(error.message).toBe('Code exceeded the memory limit of 128MB');
    expect(await value(runner, 'import tiny\nout = tiny.VALUE')).toBe(41);
  });

  it('reports a wheel removed from the folder without a host path', async () => {
    const dir = folder(tiny);
    const runner = make({ externalAllow: ['tiny'], wheelsDir: dir });
    expect(await value(runner, 'import tiny\nout = tiny.VALUE')).toBe(41);
    rmSync(path.join(dir, 'tiny-1.0-py3-none-any.whl'));
    const error = await failure(runner.run(input('import tiny')));
    expect(error.message).toBe("ImportError: Couldn't read wheel 'tiny-1.0-py3-none-any.whl'.");
  });

  it('reports a damaged wheel without a host path', async () => {
    const whole = zip({ 'tiny/__init__.py': 'VALUE = 1\n', ...info('tiny-1.0') });
    whole[35] = (whole[35] ?? 0) ^ 0xff; // inside the first deflated entry
    const dir = folder({ 'tiny-1.0-py3-none-any.whl': whole });
    const error = await failure(make({ externalAllow: ['tiny'], wheelsDir: dir }).run(input('import tiny')));
    expect(error).toBeInstanceOf(CodeExecutionError);
    expect(error.message).toMatch(/^(BadZipFile|error):/);
    expect(error.message).not.toContain(tmpdir());
  });
});

describe('the wheel folder', () => {
  it('is never read while the allow list is empty', async () => {
    const dir = folder(tiny);
    const runner = make({ wheelsDir: dir });
    expect((await runner.run(input('return _items'))).length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
    expect((await runner.run(input('return _items'))).length).toBe(1);
  });

  it('runs code that imports nothing when the folder is missing or unset', async () => {
    const missing = path.join(tmpdir(), `no-wheels-${Date.now()}`);
    expect((await make({ externalAllow: ['tiny'], wheelsDir: missing }).run(input('return _items'))).length).toBe(1);
    expect((await make({ externalAllow: ['tiny'] }).run(input('return _items'))).length).toBe(1);
    const error = await failure(make({ externalAllow: ['tiny'], wheelsDir: missing }).run(input('import tiny')));
    expect(error.message).toContain("No module named 'tiny'");
    expect(error.message).not.toContain(missing);
  });

  it('indexes import names and skips what is not a wheel', () => {
    const dir = folder({
      'tiny-1.0-py3-none-any.whl': {
        'tiny/__init__.py': '',
        'single.py': '',
        'native.cpython-314-wasm32-emscripten.so': Buffer.from('x'),
        'tiny.libs/lib.so': Buffer.from('x'),
        'notes.txt': 'x',
        ...info('tiny-1.0'),
      },
      'readme.txt': Buffer.from('not a wheel'),
      'broken-1.0-py3-none-any.whl': Buffer.from('not a zip'),
    });
    mkdirSync(path.join(dir, 'folder-1.0-py3-none-any.whl'));
    const wheels = readWheelFolder(dir);
    expect([...wheels.roots.keys()].sort()).toEqual(['native', 'single', 'tiny']);
    expect([...wheels.files.keys()]).toEqual(['tiny-1.0-py3-none-any.whl']);
    expect(wheels.unusable.size).toBe(0);
  });

  it('gives an empty index for a folder that does not exist', () => {
    const wheels = readWheelFolder(path.join(tmpdir(), `no-wheels-${Date.now()}`));
    expect(wheels.roots.size + wheels.unusable.size + wheels.files.size).toBe(0);
  });
});

describe('the asset loader', () => {
  it('hands out a listed wheel by file name and nothing else', () => {
    const dir = folder(tiny);
    writeFileSync(path.join(dir, 'secret.txt'), 'secret');
    const load = pythonAssetLoader(128, readWheelFolder(dir));
    expect(load('wheel:tiny-1.0-py3-none-any.whl')).toBeDefined();
    for (const name of ['wheel:secret.txt', 'wheel:../secret.txt', `wheel:${path.join(dir, 'secret.txt')}`, 'wheel:', 'secret.txt']) {
      expect(() => load(name)).toThrow('Unknown Python asset');
    }
  });

  it('hands out no wheel without an index', () => {
    expect(() => pythonAssetLoader(128)('wheel:tiny-1.0-py3-none-any.whl')).toThrow('Unknown Python asset');
  });
});
