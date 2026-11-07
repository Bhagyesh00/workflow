/**
 * "Let the model define this parameter" around one input. C0 only renders the input; L3 fills it.
 * The props are final, because ParameterForm and the resource mapper rows both render this. The
 * node and the read-only state come from `useParameterContext()`.
 */
import type { NodeProperty } from '@workflow/workflow';
import type { ReactNode } from 'react';
import type { ParameterPath } from '../../lib/workflow-ops';

export interface FromAiOverrideProps {
  prop: NodeProperty;
  value: unknown;
  path: ParameterPath;
  onChange: (next: unknown) => void;
  children: ReactNode;
}

export function FromAiOverride({ children }: FromAiOverrideProps) {
  return <>{children}</>;
}
