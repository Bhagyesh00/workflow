/**
 * Rules and text of a parameter the model defines through `$fromAI` (P5-75, filled by L3). The
 * value is a data placeholder for the tool call, written with `FROM_AI_MARKER` so it reads back.
 */
import type { FromAiArgument, NodeParameters, NodeProperty, NodeTypeDescription } from '@workflow/workflow';
import type { ParameterPath } from './workflow-ops';

export interface FromAiOverrideValue {
  key: string;
  description: string;
  type: FromAiArgument['type'];
}

/** whether the override button shows for this parameter of this node type */
export function canUseFromAiOverride(
  _description: NodeTypeDescription | undefined,
  _prop: NodeProperty,
  _path: ParameterPath,
): boolean {
  throw new Error('not implemented (L3)');
}

/** the `$fromAI` key of a parameter path: `[^a-zA-Z0-9-]` becomes `_`, at most 63 characters */
export function fromAiKeyFromPath(_path: ParameterPath): string {
  throw new Error('not implemented (L3)');
}

/** the `$fromAI` type of a parameter: number, boolean, json, else string */
export function fromAiTypeOf(_prop: NodeProperty): FromAiArgument['type'] {
  throw new Error('not implemented (L3)');
}

/** the expression: `FROM_AI_MARKER`, then `$fromAI('Key', 'description', 'type')`, best quote and escaping */
export function buildFromAiOverride(_override: FromAiOverrideValue): string {
  throw new Error('not implemented (L3)');
}

/** reads a value written by `buildFromAiOverride`; null for anything else */
export function parseFromAiOverride(_value: unknown): FromAiOverrideValue | null {
  throw new Error('not implemented (L3)');
}

/** after list rows move: every override's key follows its new path */
export function reconcileFromAiKeys(_parameters: NodeParameters): NodeParameters {
  throw new Error('not implemented (L3)');
}
