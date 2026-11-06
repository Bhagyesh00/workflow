/**
 * The files of the pinned `pyodide` package, read once per server and handed to isolates only by
 * fixed name. The wasm's declared memory maximum is rewritten here: wasm memory is not part of the
 * isolate's memoryLimit, and a module that declares a smaller maximum cannot grow past it by any path.
 * Wheels of RUNNERS_PYTHON_WHEELS_DIR go in the same way, by the file names of an index read here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ivm from 'isolated-vm';

const require = createRequire(import.meta.url);
const WASM_PAGE_BYTES = 64 * 1024;
const WASM_NAME = 'pyodide.asm.wasm';
const STDLIB_NAME = 'python_stdlib.zip';
const WHEEL_ASSET_PREFIX = 'wheel:';
const MEMORY_SECTION = 5;
/** the wasm starts with `\0asm` and a version */
const WASM_HEADER_BYTES = 8;
/** the module's own start needs this much; a smaller limit could not restore the interpreter */
export const MIN_WASM_MEMORY_MB = 64;

let packageDir: string | undefined;
function assetPath(name: string): string {
  packageDir ??= path.dirname(require.resolve('pyodide/package.json'));
  return path.join(packageDir, name);
}

function readLeb(bytes: Uint8Array, offset: number): { value: number; size: number } {
  let value = 0;
  let size = 0;
  for (;;) {
    const byte = bytes[offset + size];
    if (byte === undefined) throw new Error('Pyodide wasm ends inside a number');
    value += (byte & 0x7f) * 2 ** (7 * size);
    size += 1;
    if (!(byte & 0x80)) return { value, size };
  }
}

/** where the maximum of the module's one memory sits */
function findMemoryMax(bytes: Uint8Array): { value: number; size: number; offset: number } {
  let offset = WASM_HEADER_BYTES;
  while (offset < bytes.length) {
    const id = bytes[offset];
    const length = readLeb(bytes, offset + 1);
    const start = offset + 1 + length.size;
    if (id === MEMORY_SECTION) {
      const count = readLeb(bytes, start);
      const flags = bytes[start + count.size];
      const initialAt = start + count.size + 1;
      const initial = readLeb(bytes, initialAt);
      // bit 0 = has a maximum; a shared or 64-bit memory would need other handling
      if (count.value !== 1 || flags !== 1) throw new Error('Pyodide wasm has an unexpected memory section');
      const offsetOfMax = initialAt + initial.size;
      return { ...readLeb(bytes, offsetOfMax), offset: offsetOfMax };
    }
    offset = start + length.value;
  }
  throw new Error('Pyodide wasm has no memory section');
}

export function wasmMemoryMaxPages(bytes: Uint8Array): number {
  return findMemoryMax(bytes).value;
}

/** a copy of the wasm whose memory cannot pass `memoryMb`, at the same length (padded number) */
export function cappedWasmBytes(memoryMb: number): Buffer {
  const bytes = Buffer.from(readFileSync(assetPath(WASM_NAME)));
  const max = findMemoryMax(bytes);
  let rest = Math.floor((Math.max(memoryMb, MIN_WASM_MEMORY_MB) * 1024 * 1024) / WASM_PAGE_BYTES);
  for (let i = 0; i < max.size; i += 1) {
    const more = i < max.size - 1;
    bytes[max.offset + i] = (rest & 0x7f) | (more ? 0x80 : 0);
    rest = Math.floor(rest / 128);
  }
  if (rest !== 0) throw new Error('Pyodide wasm memory limit does not fit its slot');
  return bytes;
}

/** the text of the two Pyodide scripts and the lock file; `import.meta.url` has no meaning in an isolate */
let sources: { runtime: string; loader: string; lockJson: string } | undefined;
export function pyodideSources(): { runtime: string; loader: string; lockJson: string } {
  sources ??= {
    runtime: readFileSync(assetPath('pyodide.asm.mjs'), 'utf8')
      .split('import.meta.url')
      .join('"/pyodide/pyodide.asm.mjs"'),
    loader: readFileSync(assetPath('pyodide.mjs'), 'utf8'),
    lockJson: readFileSync(assetPath('pyodide-lock.json'), 'utf8'),
  };
  return sources;
}

export interface PythonWheels {
  /** import name -> the wheels that provide it (more than one for a namespace package) */
  roots: Map<string, string[]>;
  /** import name -> a wheel that provides it but cannot run in Pyodide */
  unusable: Map<string, string>;
  /** wheel file name -> where it is: the only names the asset loader hands out */
  files: Map<string, string>;
}

const ZIP_END = 0x06054b50;
const ZIP_ENTRY = 0x02014b50;
const ZIP_END_BYTES = 22;
const ZIP_ENTRY_BYTES = 46;
const IMPORT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** the entry names of a zip's central directory, or undefined when it is not a zip */
function zipEntryNames(bytes: Buffer): string[] | undefined {
  let end = bytes.length - ZIP_END_BYTES;
  // the end record may be followed by a comment of up to 64 KiB
  const lowest = Math.max(0, end - 0xffff);
  while (end >= lowest && bytes.readUInt32LE(end) !== ZIP_END) end -= 1;
  if (end < lowest) return undefined;
  const names: string[] = [];
  let at = bytes.readUInt32LE(end + 16);
  while (at + ZIP_ENTRY_BYTES <= bytes.length && bytes.readUInt32LE(at) === ZIP_ENTRY) {
    const nameBytes = bytes.readUInt16LE(at + 28);
    const rest = bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    names.push(bytes.toString('utf8', at + ZIP_ENTRY_BYTES, at + ZIP_ENTRY_BYTES + nameBytes));
    at += ZIP_ENTRY_BYTES + nameBytes + rest;
  }
  return names.length > 0 ? names : undefined;
}

/** the names `import` reaches a wheel by; they need not match the wheel's own name */
function importRoots(entries: string[]): string[] {
  const roots = new Set<string>();
  for (const entry of entries) {
    const slash = entry.indexOf('/');
    const isModule = slash >= 0 || /\.(py|so)$/.test(entry);
    const root = slash >= 0 ? entry.slice(0, slash) : entry.slice(0, entry.indexOf('.'));
    if (isModule && IMPORT_NAME.test(root)) roots.add(root);
  }
  return [...roots];
}

/** pure Python for Python 3, or built for this Pyodide's ABI; the file name carries the tags */
function canRunInPyodide(file: string): boolean {
  const parts = file.slice(0, -'.whl'.length).split('-');
  if (parts.length < 5) return false;
  const [python = '', abi = '', platform = ''] = parts.slice(-3);
  const { info } = JSON.parse(pyodideSources().lockJson) as {
    info: { python: string; abi_version: string; arch: string };
  };
  const [major, minor] = info.python.split('.');
  const pythonTags = python.split('.');
  const thisPython = `cp${major}${minor}`;
  if (platform === 'any') {
    return abi === 'none' && pythonTags.some((tag) => tag.startsWith('py3') || tag === thisPython);
  }
  const built = [`pyemscripten_${info.abi_version}_${info.arch}`, `pyodide_${info.abi_version}_${info.arch}`];
  return (abi === 'abi3' || pythonTags.includes(thisPython)) && platform.split('.').some((tag) => built.includes(tag));
}

function readEntries(file: string): string[] | undefined {
  try {
    return zipEntryNames(readFileSync(file));
  } catch {
    return undefined;
  }
}

/**
 * Indexes a wheel folder. One wheel per package: the highest version that can run. A file that is not a
 * readable zip is skipped; a folder that cannot be read is empty, so such a package gives No module named.
 */
export function readWheelFolder(dir: string): PythonWheels {
  const wheels: PythonWheels = { roots: new Map(), unusable: new Map(), files: new Map() };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return wheels;
  }
  const newestFirst = names
    .filter((name) => name.endsWith('.whl'))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const taken = new Set<string>();
  const cannotRun: Array<[string, string[]]> = [];
  for (const file of newestFirst) {
    const entries = readEntries(path.join(dir, file));
    if (!entries) continue;
    const roots = importRoots(entries);
    if (!canRunInPyodide(file)) {
      cannotRun.push([file, roots]);
      continue;
    }
    const dist = (file.split('-')[0] ?? file).toLowerCase().replace(/[-_.]+/g, '-');
    if (taken.has(dist)) continue;
    taken.add(dist);
    wheels.files.set(file, path.join(dir, file));
    for (const root of roots) wheels.roots.set(root, [...(wheels.roots.get(root) ?? []), file]);
  }
  for (const [file, roots] of cannotRun) {
    for (const root of roots) {
      if (!wheels.roots.has(root) && !wheels.unusable.has(root)) wheels.unusable.set(root, file);
    }
  }
  return wheels;
}

function toCopy(bytes: Buffer): ivm.ExternalCopy<ArrayBuffer> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new ivm.ExternalCopy(buffer);
}

const wasmCopies = new Map<number, ivm.ExternalCopy<ArrayBuffer>>();
let stdlibCopy: ivm.ExternalCopy<ArrayBuffer> | undefined;

/**
 * The isolate's read-only file loader: fixed names in, bytes out, for one memory limit, plus the wheels
 * of the index by file name. Any other name is refused; a name is never joined into a host path.
 */
export function pythonAssetLoader(memoryMb: number, wheels?: PythonWheels): (name: string) => unknown {
  return (name) => {
    if (name === WASM_NAME) {
      let copy = wasmCopies.get(memoryMb);
      if (!copy) {
        copy = toCopy(cappedWasmBytes(memoryMb));
        wasmCopies.set(memoryMb, copy);
      }
      return copy.copyInto({ release: false });
    }
    if (name === STDLIB_NAME) {
      stdlibCopy ??= toCopy(readFileSync(assetPath(STDLIB_NAME)));
      return stdlibCopy.copyInto({ release: false });
    }
    const wheel = name.startsWith(WHEEL_ASSET_PREFIX) ? wheels?.files.get(name.slice(WHEEL_ASSET_PREFIX.length)) : undefined;
    if (wheel) return toCopy(readFileSync(wheel)).copyInto({ release: true });
    throw new Error('Unknown Python asset');
  };
}
