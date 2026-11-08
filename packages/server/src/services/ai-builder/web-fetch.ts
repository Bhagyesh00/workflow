/**
 * Web fetch (P5-64, L4). A seam `builder.ts` calls from the start; until L4 fills it, build mode has no
 * `web_fetch` tool and a resume changes nothing.
 * L4: https only (http on loopback in tests), host compared by `===`, an unapproved host emits
 * `web-fetch-approval` and calls `stopTurn`; the fetch goes through `deps.ctx.http` with
 * `allowedDomains: [host]` and `followRedirects: false`, own loop of at most 3 hops; page text reaches
 * `state.promptNotes` only through `wrapUntrusted`. No credential, no cookie.
 */
import type { AiTool, BuilderResume } from '@workflow/workflow';
import type { BuilderToolDeps } from './tools';
import type { BuilderTurnState } from './types';

/** the `web_fetch` tool of build mode; C0 offers none */
export function webFetchTools(_state: BuilderTurnState, _deps: BuilderToolDeps): AiTool[] {
  return [];
}

/** applies a web fetch approval or denial; C0 does nothing */
export async function applyWebFetchResume(
  _state: BuilderTurnState,
  _resume: BuilderResume | undefined,
  _deps: BuilderToolDeps,
): Promise<void> {}
