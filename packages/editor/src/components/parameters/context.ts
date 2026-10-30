import type { NodeParameters, NodeProperty, NodeTypeDescription, WorkflowNode } from '@workflow/workflow';
import { createContext, useContext } from 'react';
import type { PreviewResult } from '../../lib/expression-context';
import type { ParameterPath } from '../../lib/workflow-ops';
import type { CompletionData } from '../code/completions';

export interface ParameterContextValue {
  /** the node being edited (credential forms pass a synthetic node) */
  node: WorkflowNode;
  description?: NodeTypeDescription;
  /** root values, used for `/name` display options and `loadOptionsDependsOn` */
  rootValues: NodeParameters;
  readOnly: boolean;
  /** credential forms do not support expressions */
  allowExpressions: boolean;
  onChange(path: ParameterPath, value: unknown): void;
  preview?(expression: string): PreviewResult;
  completions?(): CompletionData | undefined;
  onButton?(prop: NodeProperty): void;
  /** credential edit forms: clearing a saved secret keeps it (sends the redaction sentinel) */
  keepSecretOnEmpty?: boolean;
}

export const ParameterContext = createContext<ParameterContextValue | null>(null);

export function useParameterContext(): ParameterContextValue {
  const ctx = useContext(ParameterContext);
  if (!ctx) throw new Error('ParameterContext is missing');
  return ctx;
}

/** MIME type for fields dragged from the input pane onto parameters */
export const FIELD_DRAG_TYPE = 'application/x-wf-expression';

export function readDroppedExpression(event: React.DragEvent): string | null {
  const value = event.dataTransfer.getData(FIELD_DRAG_TYPE);
  return value || null;
}

/** Types whose value can be switched between a fixed value and an expression. */
export const EXPRESSION_CAPABLE = new Set<NodeProperty['type']>([
  'string',
  'number',
  'boolean',
  'options',
  'multiOptions',
  'json',
  'color',
  'dateTime',
  'resourceLocator',
]);

export function isExpressionValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('=');
}
