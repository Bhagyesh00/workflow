/**
 * A tool that has to wait for a person (human review, Wait, send and wait) stops the agent's run with a
 * `ToolSuspension`. The engine stores `ToolSuspensionState` with the execution and hands `ToolResumeData`
 * back to the agent when the wait ends. Both states go through JSON; the error itself is never stored.
 */
import type { DataObject, ExecuteData, Item } from './interfaces';

/** global registry symbol: a second copy of this package still recognises the error */
const TOOL_SUSPENSION_BRAND = Symbol.for('@workflow/workflow.ToolSuspension');

export class ToolSuspension extends Error {
  readonly toolNode: string;
  readonly waitTill: Date;
  readonly toolName: string;
  readonly toolCallId: string;
  /** set by a human review gate: the tool to run once the answer is an approval */
  readonly gatedTool?: { name: string; arguments: DataObject };

  constructor(fields: {
    toolNode: string;
    waitTill: Date;
    toolName: string;
    toolCallId: string;
    gatedTool?: { name: string; arguments: DataObject };
  }) {
    super(`Tool "${fields.toolName}" is waiting`);
    this.name = 'ToolSuspension';
    this.toolNode = fields.toolNode;
    this.waitTill = fields.waitTill;
    this.toolName = fields.toolName;
    this.toolCallId = fields.toolCallId;
    this.gatedTool = fields.gatedTool;
    Object.defineProperty(this, TOOL_SUSPENSION_BRAND, { value: true });
  }
}

export function isToolSuspension(e: unknown): e is ToolSuspension {
  return e instanceof Error && (e as unknown as Record<symbol, unknown>)[TOOL_SUSPENSION_BRAND] === true;
}

/** stored at `ExecutionState.executionData.suspended` while the execution waits */
export interface ToolSuspensionState {
  agentNode: string;
  exec: ExecuteData;
  toolNode: string;
  toolRunIndex: number;
  toolCallId: string;
  checkpoint: DataObject;
}

/** what the agent reads through `ctx.getResumeData()` on the run after the wait */
export interface ToolResumeData {
  checkpoint: DataObject;
  toolCallId: string;
  /** the waiting tool's output; null when the wait timed out */
  answer: Item[][] | null;
}

/** Only `approved === true` or `data.approved === true` on the first item approves; anything else declines. */
export function hitlApproved(answer: Item[][] | null): boolean {
  const json = answer?.[0]?.[0]?.json;
  if (!json) return false;
  if (json.approved === true) return true;
  const data = json.data;
  return (
    data !== null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    (data as DataObject).approved === true
  );
}
