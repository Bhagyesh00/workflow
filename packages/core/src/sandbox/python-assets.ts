/**
 * The files of the pinned `pyodide` package, read once per server and handed to isolates only by
 * fixed name. The wasm's declared memory maximum is rewritten here: wasm memory is not part of the
 * isolate's memoryLimit, and a module that declares a smaller maximum cannot grow past it by any path.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ivm from 'isolated-vm';

const require = createRequire(import.meta.url);
const WASM_PAGE_BYTES = 64 * 1024;
const WASM_NAME = 'pyodide.asm.wasm';
const STDLIB_NAME = 'python_stdlib.zip';
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

function toCopy(bytes: Buffer): ivm.ExternalCopy<ArrayBuffer> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new ivm.ExternalCopy(buffer);
}

const wasmCopies = new Map<number, ivm.ExternalCopy<ArrayBuffer>>();
let stdlibCopy: ivm.ExternalCopy<ArrayBuffer> | undefined;

/**
 * The isolate's read-only file loader: fixed names in, bytes out, for one memory limit. Any other
 * name is refused; there is no path from this function to the host file system.
 */
export function pythonAssetLoader(memoryMb: number): (name: string) => unknown {
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
    throw new Error('Unknown Python asset');
  };
}
