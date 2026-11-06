/**
 * What runs inside the Python isolate: the JavaScript shims Pyodide needs in a bare V8 context, the
 * steps that start it, and the Python that guards and runs user code.
 *
 * The isolate is the boundary. globalThis holds these shims only. The Python rules below (import
 * lists, builtins deny list, AST checks, n8n's texts) are n8n's in-language parity on top of it.
 */

/**
 * Bare V8 has no timers, text codecs or clock. `read` and `load` make Pyodide take its shell path,
 * which reads files with `readbuffer`; here that is the host's fixed-name loader.
 * WebAssembly's async entry points never settle in a bare isolate, so they run synchronously.
 */
export const ISOLATE_SHIMS = `
"use strict";
(() => {
  const asset = __asset;
  const random = __random;
  delete globalThis.__asset;
  delete globalThis.__random;

  const cancelled = new Set();
  let nextTimer = 1;
  // no event loop runs here: callbacks go in order on the microtask queue, whatever the delay
  globalThis.setTimeout = (callback, _delay, ...args) => {
    const id = nextTimer++;
    Promise.resolve().then(() => {
      if (!cancelled.delete(id)) callback(...args);
    });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    cancelled.add(id);
  };

  const startedAt = Date.now();
  globalThis.performance = Object.freeze({ now: () => Date.now() - startedAt, timeOrigin: startedAt });

  const noop = () => {};
  globalThis.console = Object.freeze({ log: noop, info: noop, debug: noop, warn: noop, error: noop });

  const RANDOM_CHUNK = 65536;
  globalThis.crypto = Object.freeze({
    getRandomValues(view) {
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      for (let at = 0; at < bytes.length; at += RANDOM_CHUNK) {
        const size = Math.min(RANDOM_CHUNK, bytes.length - at);
        bytes.set(new Uint8Array(random(size)), at);
      }
      return view;
    },
  });

  class TextEncoderShim {
    get encoding() {
      return 'utf-8';
    }
    encode(input = '') {
      const text = String(input);
      const out = new Uint8Array(text.length * 3);
      return out.slice(0, this.encodeInto(text, out).written);
    }
    encodeInto(input, target) {
      const text = String(input);
      let read = 0;
      let written = 0;
      while (read < text.length) {
        let code = text.codePointAt(read);
        const units = code > 0xffff ? 2 : 1;
        if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
        const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
        if (written + size > target.length) break;
        if (size === 1) {
          target[written] = code;
        } else if (size === 2) {
          target[written] = 0xc0 | (code >> 6);
          target[written + 1] = 0x80 | (code & 63);
        } else if (size === 3) {
          target[written] = 0xe0 | (code >> 12);
          target[written + 1] = 0x80 | ((code >> 6) & 63);
          target[written + 2] = 0x80 | (code & 63);
        } else {
          target[written] = 0xf0 | (code >> 18);
          target[written + 1] = 0x80 | ((code >> 12) & 63);
          target[written + 2] = 0x80 | ((code >> 6) & 63);
          target[written + 3] = 0x80 | (code & 63);
        }
        written += size;
        read += units;
      }
      return { read, written };
    }
  }

  const CHARS_PER_CALL = 8192;
  function fromUnits(units) {
    let text = '';
    for (let at = 0; at < units.length; at += CHARS_PER_CALL) {
      text += String.fromCharCode.apply(null, units.subarray(at, at + CHARS_PER_CALL));
    }
    return text;
  }

  function decodeUtf8(bytes, fatal) {
    const units = new Uint16Array(bytes.length);
    let size = 0;
    let at = 0;
    while (at < bytes.length) {
      const first = bytes[at];
      if (first < 0x80) {
        units[size++] = first;
        at += 1;
        continue;
      }
      const extra = first >= 0xc2 && first <= 0xdf ? 1 : first >= 0xe0 && first <= 0xef ? 2 : first >= 0xf0 && first <= 0xf4 ? 3 : 0;
      let code = extra === 1 ? first & 31 : extra === 2 ? first & 15 : first & 7;
      let good = extra > 0;
      let used = 1;
      for (let i = 1; good && i <= extra; i += 1) {
        const next = bytes[at + i];
        const low = i === 1 && first === 0xe0 ? 0xa0 : i === 1 && first === 0xf0 ? 0x90 : 0x80;
        const high = i === 1 && first === 0xed ? 0x9f : i === 1 && first === 0xf4 ? 0x8f : 0xbf;
        if (next === undefined || next < low || next > high) {
          good = false;
        } else {
          code = (code << 6) | (next & 63);
          used += 1;
        }
      }
      at += used;
      if (!good) {
        if (fatal) throw new TypeError('The encoded data was not valid');
        units[size++] = 0xfffd;
      } else if (code > 0xffff) {
        units[size++] = 0xd800 + ((code - 0x10000) >> 10);
        units[size++] = 0xdc00 + ((code - 0x10000) & 1023);
      } else {
        units[size++] = code;
      }
    }
    return fromUnits(units.subarray(0, size));
  }

  const ENCODINGS = {
    utf8: 'utf-8',
    'utf-8': 'utf-8',
    latin1: 'latin1',
    ascii: 'latin1',
    'iso-8859-1': 'latin1',
    'utf-16le': 'utf-16le',
    'utf-16': 'utf-16le',
  };

  class TextDecoderShim {
    constructor(label = 'utf-8', options = {}) {
      const encoding = ENCODINGS[String(label).toLowerCase()];
      if (!encoding) throw new RangeError('Unsupported encoding: ' + label);
      this.encoding = encoding;
      this.fatal = Boolean(options.fatal);
      this.ignoreBOM = Boolean(options.ignoreBOM);
    }
    decode(input) {
      if (input === undefined) return '';
      const bytes = ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
      if (this.encoding === 'latin1') return fromUnits(bytes);
      if (this.encoding === 'utf-16le') {
        const units = new Uint16Array(bytes.length >> 1);
        for (let i = 0; i < units.length; i += 1) units[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
        return fromUnits(units);
      }
      const text = decodeUtf8(bytes, this.fatal);
      return !this.ignoreBOM && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    }
  }

  globalThis.TextEncoder = TextEncoderShim;
  globalThis.TextDecoder = TextDecoderShim;

  const Wasm = globalThis.WebAssembly;
  Wasm.compile = async (bytes) => new Wasm.Module(bytes);
  Wasm.instantiate = async (source, imports) => {
    if (source instanceof Wasm.Module) return new Wasm.Instance(source, imports);
    const module = new Wasm.Module(source);
    return { module, instance: new Wasm.Instance(module, imports) };
  };

  // the three names Pyodide tests to take its shell path; deleted again once it has started
  globalThis.read = () => {
    throw new Error('Files are not available');
  };
  globalThis.load = () => {
    throw new Error('Files are not available');
  };
  globalThis.readbuffer = (name) => new Uint8Array(asset(String(name).replace('/pyodide/', '')));
})();
`;

/**
 * Starts Pyodide with `__createPyodideModule`, `__loadPyodide` and `__lockJson` set by the host, from
 * `__snapshot` when set. The result is left in `__pyodide`. `window` exists only for the runtime's
 * first line: with it the runtime takes randomness from `crypto`, not from a shell command.
 */
export const ISOLATE_START = `
(async () => {
  const create = __createPyodideModule;
  const load = __loadPyodide;
  const lock = JSON.parse(__lockJson);
  const snapshot = globalThis.__snapshot;
  const readFile = globalThis.readbuffer;
  delete globalThis.__createPyodideModule;
  delete globalThis.__loadPyodide;
  delete globalThis.__lockJson;
  delete globalThis.__snapshot;
  const pyodide = await load({
    indexURL: '/pyodide/',
    createPyodideModule: (settings) => {
      globalThis.window = {};
      const started = create(settings);
      delete globalThis.window;
      return started;
    },
    lockFileContents: lock,
    jsglobals: {},
    stdout: () => {},
    stderr: () => {},
    ...(snapshot ? { _loadSnapshot: new Uint8Array(snapshot) } : { _makeSnapshot: true }),
  });
  delete globalThis.read;
  delete globalThis.load;
  delete globalThis.readbuffer;
  globalThis.__readWheel = (file) => readFile('wheel:' + file);
  globalThis.__pyodide = pyodide;
})()
`;

/** Runs PYTHON_BOOTSTRAP (in `__bootstrap`) in a fresh interpreter and returns its memory as bytes. */
export const ISOLATE_MAKE_SNAPSHOT = `
(async () => {
  __pyodide.runPython(__bootstrap);
  return new Uint8Array(__pyodide.makeMemorySnapshot()).buffer;
})()
`;

/**
 * Takes the guarded entry point out of the restored interpreter and calls it once with `__payload`.
 * Python's one way back to JavaScript is fetchWheel: a name in, a fixed in-memory file and a boolean
 * out. It has no prototype and throws nothing, so no JavaScript object reaches Python through it.
 */
export const ISOLATE_RUN = `
(async () => {
  const payload = __payload;
  delete globalThis.__payload;
  const readWheel = __readWheel;
  delete globalThis.__readWheel;
  const pyodide = __pyodide;
  delete globalThis.__pyodide;
  const run = pyodide.globals.get('__sandbox_run');
  pyodide.globals.delete('__sandbox_run');
  const fetchWheel = (file) => {
    try {
      pyodide.FS.writeFile('/tmp/wheel.whl', readWheel(String(file)));
      return true;
    } catch {
      return false;
    }
  };
  Object.setPrototypeOf(fetchWheel, null);
  return run(payload, fetchWheel);
})()
`;

/**
 * Written once, before any user code, into the memory snapshot every run starts from. The entry
 * point takes the run's JSON and always returns JSON: {result, prints} or {error, prints}.
 */
export const PYTHON_BOOTSTRAP = String.raw`
def __make_sandbox():
    import ast, builtins, importlib, json, math, os, re, sys, types

    CODE_FILE = "<code>"
    MAX_PRINT_CALLS = 100
    # always blocked, whatever the allow lists say
    BLOCKED_ROOTS = ("js", "micropip")
    BLOCKED_PREFIXES = ("pyodide", "_pyodide")
    ITEM_MODE = "runOnceForEachItem"

    STDLIB_TEXT = "Import of standard library module '{}' is disallowed. Allowed stdlib modules: {}"
    EXTERNAL_TEXT = "Import of external package '{}' is disallowed. Allowed external packages: {}"
    RELATIVE_TEXT = "Relative imports are disallowed."
    DYNAMIC_TEXT = "Dynamic __import__() calls are not allowed for security reasons."
    NAME_TEXT = "Access to name '{}' is disallowed, because it can be used to bypass security restrictions."
    ATTRIBUTE_TEXT = "Access to attribute '{}' is disallowed, because it can be used to bypass security restrictions."
    MANGLED_TEXT = "Access to name-mangled attributes (two leading underscores) is disallowed for security reasons."
    MATCH_TEXT = "Positional sub-patterns in a match class pattern are disallowed for security reasons."
    STRING_TEXT = "A string containing '{}' is disallowed, because it can be used to bypass security restrictions."
    FORMAT_TEXT = "Access to attribute '{}' is only allowed in a direct call, because it can be used to bypass security restrictions."
    WHEEL_RUN_TEXT = "Wheel '{}' cannot run in the Python sandbox. Only pure-Python and Pyodide wheels work."
    WHEEL_READ_TEXT = "Couldn't read wheel '{}'."

    # the same name as in fetchWheel (ISOLATE_RUN)
    WHEEL_FILE = "/tmp/wheel.whl"
    # after the standard library on sys.path, so a wheel cannot replace a stdlib module
    WHEELS_PATH = "/lib/wheels"

    BLOCKED_NAMES = {"__builtins__", "__globals__", "__loader__", "__spec__", "__name__"}
    BLOCKED_ATTRIBUTES = {
        "__annotations__", "__base__", "__bases__", "__builtins__", "__cause__", "__class__",
        "__class_getitem__", "__closure__", "__code__", "__context__", "__defaults__", "__delattr__",
        "__dict__", "__func__", "__getattr__", "__getattribute__", "__getstate__", "__globals__",
        "__import__", "__init_subclass__", "__kwdefaults__", "__loader__", "__mro__", "__mro_entries__",
        "__module__", "__name__", "__objclass__", "__package__", "__prepare__", "__qualname__",
        "__reduce__", "__reduce_ex__", "__self__", "__self_class__", "__set_name__", "__setattr__",
        "__setstate__", "__spec__", "__subclasses__", "__subclasshook__", "__thisclass__",
        "__traceback__", "__type_params__", "__wrapped__", "mro",
        "ag_await", "ag_code", "ag_frame", "ag_running",
        "cr_await", "cr_code", "cr_frame", "cr_origin", "cr_running",
        "f_back", "f_builtins", "f_code", "f_globals", "f_lasti", "f_lineno", "f_locals", "f_trace",
        "gi_code", "gi_frame", "gi_running", "gi_yieldfrom",
        "tb_frame", "tb_lasti", "tb_lineno", "tb_next",
    }
    FORMAT_ATTRIBUTES = {"format", "format_map"}
    DUNDER_NAMES = sorted(n for n in BLOCKED_NAMES | BLOCKED_ATTRIBUTES if n.startswith("__"))
    DUNDER_PATTERN = re.compile("|".join(re.escape(n) for n in DUNDER_NAMES))
    # not reachable from user builtins
    HIDDEN_BUILTINS = {"__loader__", "__spec__", "__package__", "__import__", "print"}

    real_import = builtins.__import__
    real_import_module = importlib.import_module
    run_exec = exec
    stdlib_names = sys.stdlib_module_names

    class SecurityViolation(Exception):
        pass

    def is_blocked(root):
        return root in BLOCKED_ROOTS or root.startswith(BLOCKED_PREFIXES)

    def root_of(name):
        return name.partition(".")[0]

    def shown(names):
        return ", ".join(sorted(names)) or "none"

    def import_refusal(name, options):
        root = root_of(name)
        if root in stdlib_names:
            allowed = options["stdlibAllow"]
            if "*" in allowed or root in allowed:
                return None
            return STDLIB_TEXT.format(root, shown(allowed))
        allowed = [n for n in options["externalAllow"] if not is_blocked(n)]
        if not is_blocked(root) and ("*" in allowed or root in allowed):
            return None
        return EXTERNAL_TEXT.format(root, shown(allowed))

    def attribute_refusal(name):
        if name in BLOCKED_ATTRIBUTES:
            return ATTRIBUTE_TEXT.format(name)
        if name.startswith("__") and not name.endswith("__"):
            return MANGLED_TEXT
        return None

    def validate(tree, options):
        found = []
        add = lambda node, text: found.append((getattr(node, "lineno", 0), text))
        called = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                called.add(id(node.func))
        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                if node.id == "__import__":
                    add(node, DYNAMIC_TEXT)
                elif node.id in BLOCKED_NAMES:
                    add(node, NAME_TEXT.format(node.id))
            elif isinstance(node, ast.Attribute):
                refusal = attribute_refusal(node.attr)
                if refusal:
                    add(node, refusal)
                elif node.attr in FORMAT_ATTRIBUTES and id(node) not in called:
                    add(node, FORMAT_TEXT.format(node.attr))
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    refusal = import_refusal(alias.name, options)
                    if refusal:
                        add(node, refusal)
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    add(node, RELATIVE_TEXT)
                else:
                    refusal = import_refusal(node.module or "", options)
                    if refusal:
                        add(node, refusal)
                for alias in node.names:
                    refusal = attribute_refusal(alias.name)
                    if refusal:
                        add(node, refusal)
            elif isinstance(node, ast.MatchClass):
                if node.patterns:
                    add(node, MATCH_TEXT)
                for name in node.kwd_attrs:
                    refusal = attribute_refusal(name)
                    if refusal:
                        add(node, refusal)
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                match = DUNDER_PATTERN.search(node.value)
                if match:
                    add(node, STRING_TEXT.format(match.group(0)))
        if found:
            lines = []
            for line, text in sorted(set(found)):
                lines.append("Line {}: {}".format(line, text))
            raise SecurityViolation("Security violations detected:\n" + "\n".join(lines))

    def make_import(options):
        transitive = options["allowTransitiveImports"]

        def module_view(module):
            view = ModuleView(module.__name__)
            types.ModuleType.__setattr__(view, "_view_target", module)
            return view

        def checked_import_module(name, package=None):
            if name.startswith("."):
                raise ImportError(RELATIVE_TEXT)
            refusal = import_refusal(name, options)
            if refusal:
                raise ImportError(refusal)
            return module_view(real_import_module(name))

        class ModuleView(types.ModuleType):
            """An allowed module as user code sees it: read-only, and it hands out no other module."""

            def __getattribute__(self, name):
                target = types.ModuleType.__getattribute__(self, "_view_target")
                if target.__name__ == "importlib" and name == "import_module":
                    return checked_import_module
                if target.__name__ == "importlib" and name == "__import__":
                    return checked_import
                value = getattr(target, name)
                if isinstance(value, types.ModuleType):
                    refusal = import_refusal(value.__name__, options)
                    if refusal and not (transitive and not is_blocked(root_of(value.__name__))):
                        raise ImportError(refusal)
                    if root_of(value.__name__) == root_of(target.__name__) or not transitive:
                        return module_view(value)
                return value

            def __setattr__(self, name, value):
                if not transitive:
                    raise AttributeError("Modules cannot be changed from the Code node")
                setattr(types.ModuleType.__getattribute__(self, "_view_target"), name, value)

        def checked_import(name, globals=None, locals=None, fromlist=(), level=0):
            if level:
                raise ImportError(RELATIVE_TEXT)
            refusal = import_refusal(name, options)
            if refusal:
                raise ImportError(refusal)
            return module_view(real_import(name, globals, locals, fromlist, 0))

        return checked_import

    class BlockedFinder:
        """First on sys.meta_path, so even a module allowed to import anything cannot load these."""

        @staticmethod
        def find_spec(name, path=None, target=None):
            if is_blocked(root_of(name)):
                raise ModuleNotFoundError("No module named '{}'".format(name))
            return None

    def make_wheel_finder(wheels, fetch_wheel):
        unpacked = set()

        def unpack(file):
            import zipfile
            unpacked.add(file)
            if not fetch_wheel(file):
                raise ImportError(WHEEL_READ_TEXT.format(file))
            with zipfile.ZipFile(WHEEL_FILE) as archive:
                archive.extractall(WHEELS_PATH)
            os.remove(WHEEL_FILE)
            importlib.invalidate_caches()

        class WheelFinder:
            """Unpacks a wheel when something first imports it, so a run pays only for what it uses."""

            @staticmethod
            def find_spec(name, path=None, target=None):
                root = root_of(name)
                if root in stdlib_names:
                    return None
                if root in wheels["unusable"]:
                    raise ImportError(WHEEL_RUN_TEXT.format(wheels["unusable"][root]))
                for file in wheels["roots"].get(root, ()):
                    if file not in unpacked:
                        unpack(file)
                return None

        return WheelFinder

    def lock_down(wheels, fetch_wheel):
        for name in list(sys.modules):
            if is_blocked(root_of(name)):
                del sys.modules[name]
        kept = [f for f in sys.meta_path if not is_blocked(root_of(getattr(type(f), "__module__", "")))]
        finders = [BlockedFinder]
        if wheels["roots"] or wheels["unusable"]:
            os.makedirs(WHEELS_PATH)
            sys.path.append(WHEELS_PATH)
            finders.append(make_wheel_finder(wheels, fetch_wheel))
        sys.meta_path[:] = finders + kept
        os.environ.clear()

    def make_print(prints, state):
        def show(value):
            if isinstance(value, str):
                return value
            if isinstance(value, (dict, list, tuple)):
                try:
                    return json.dumps(value, default=str, ensure_ascii=False)
                except (TypeError, ValueError):
                    pass
            return repr(value)

        def sandbox_print(*args, **_options):
            if len(prints) < MAX_PRINT_CALLS:
                prints.append([show(a) for a in args])
            else:
                state["dropped"] += 1

        return sandbox_print

    def make_builtins(options, prints, state):
        deny = set(options["builtinsDeny"]) | HIDDEN_BUILTINS
        safe = {k: v for k, v in vars(builtins).items() if k not in deny}
        safe["__import__"] = make_import(options)
        safe["print"] = make_print(prints, state)
        return safe

    def compile_code(source, options):
        tree = ast.parse(source, filename=CODE_FILE)
        validate(tree, options)
        # the user's own nodes go into a function, so a top-level return works and lines stay theirs
        wrapper = ast.parse("def __code__():\n    pass\n", filename=CODE_FILE)
        if tree.body:
            wrapper.body[0].body = tree.body
        return compile(wrapper, CODE_FILE, "exec")

    def call_user_code(compiled, safe, names):
        scope = {"__builtins__": safe, **names}
        run_exec(compiled, scope)
        return scope.pop("__code__")()

    def without_special_floats(value):
        if isinstance(value, float) and not math.isfinite(value):
            return None
        if isinstance(value, dict):
            return {k: without_special_floats(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [without_special_floats(v) for v in value]
        return value

    def to_json(value):
        # ASCII only, so no lone surrogate can break the way back to the host
        try:
            return json.dumps(value, default=str, allow_nan=False)
        except ValueError as error:
            if "Out of range float" not in str(error):
                raise
            return json.dumps(without_special_floats(value), default=str, allow_nan=False)

    def user_line(error):
        if isinstance(error, SyntaxError):
            return error.lineno
        line = None
        trace = error.__traceback__
        while trace is not None:
            if trace.tb_frame.f_code.co_filename == CODE_FILE:
                line = trace.tb_lineno
            trace = trace.tb_next
        return line

    def describe(error):
        name = type(error).__name__
        if isinstance(error, SecurityViolation):
            return str(error)
        if isinstance(error, SyntaxError):
            return "{}: {}".format(name, error.msg)
        try:
            text = str(error)
        except Exception:
            text = ""
        return "{}: {}".format(name, text) if text else name

    def finish(prints, state):
        if state["dropped"]:
            prints.append(["[Output truncated - {} more print statements]".format(state["dropped"])])

    def run(payload_json, fetch_wheel):
        prints = []
        state = {"dropped": 0}
        try:
            payload = json.loads(payload_json)
            lock_down(payload["wheels"], fetch_wheel)
            safe = make_builtins(payload, prints, state)
            compiled = compile_code(payload["code"], payload)
            if "query" in payload:
                result = call_user_code(compiled, safe, {"_items": payload["items"], "_query": payload["query"]})
            elif payload["mode"] == ITEM_MODE:
                result = [call_user_code(compiled, safe, {"_item": item}) for item in payload["items"]]
            else:
                result = call_user_code(compiled, safe, {"_items": payload["items"]})
            finish(prints, state)
            return to_json({"result": result, "prints": prints})
        except BaseException as error:
            try:
                finish(prints, state)
                return json.dumps({
                    "error": {"type": type(error).__name__, "message": describe(error), "line": user_line(error)},
                    "prints": prints,
                })
            except BaseException as inner:
                return json.dumps({"error": {"type": type(inner).__name__, "message": "", "line": None}, "prints": []})

    return run


__sandbox_run = __make_sandbox()
del __make_sandbox
`;
