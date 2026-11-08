/**
 * The AI runtime the builder needs from `@workflow/nodes-ai` (P5-09, C0 FULL). The server never imports
 * the AI package at run time by name (see node-packages.ts): it is loaded here through a variable
 * specifier, and only its types are imported statically.
 */
import type { capabilitiesOf, runAgent } from '@workflow/nodes-ai';

export interface AiRuntime {
  runAgent: typeof runAgent;
  capabilitiesOf: typeof capabilitiesOf;
}

const AI_PACKAGE = '@workflow/nodes-ai';

/**
 * The runtime from `override` (tests pass `aiRuntime` to `createContext`), else from the installed AI
 * package; undefined when the package is not installed or does not export both functions.
 */
export async function loadAiRuntime(override?: AiRuntime): Promise<AiRuntime | undefined> {
  if (override) return override;
  // a variable specifier keeps bundlers and the type checker from requiring the package
  const specifier: string = AI_PACKAGE;
  try {
    const mod = (await import(specifier)) as Record<string, unknown>;
    const run = mod.runAgent;
    const capabilities = mod.capabilitiesOf;
    if (typeof run !== 'function' || typeof capabilities !== 'function') return undefined;
    return {
      runAgent: run as AiRuntime['runAgent'],
      capabilitiesOf: capabilities as AiRuntime['capabilitiesOf'],
    };
  } catch {
    /* optional package not installed */
    return undefined;
  }
}
