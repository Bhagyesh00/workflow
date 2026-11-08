/**
 * Plan mode (P5-63, L3). A seam `builder.ts` calls from the start; until L3 fills it, plan mode offers
 * the read tools as given and a resume changes nothing.
 * L3: `planTools` adds `submit_questions` and `submit_plan` (each saves on the session's assistant
 * message, emits its chunk and calls `stopTurn`); `applyPlanResume` reads the plan or questions back
 * from the session and writes `state.promptNotes` through `wrapUntrusted`; `approve` sets
 * `state.mode = 'build'`, `reject` emits a message and calls `stopTurn`.
 */
import type { AiTool, BuilderResume } from '@workflow/workflow';
import type { BuilderTurnState } from './types';

/** plan mode's tools: never an edit tool and never web fetch */
export function planTools(_state: BuilderTurnState, readTools: AiTool[]): AiTool[] {
  return readTools;
}

/** applies a questions answer or a plan decision; C0 does nothing */
export function applyPlanResume(_state: BuilderTurnState, _resume: BuilderResume | undefined): void {}
