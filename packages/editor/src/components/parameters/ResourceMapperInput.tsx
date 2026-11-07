/**
 * The `resourceMapper` parameter: fields loaded through `methods.resourceMapping`, one row per
 * field. The props are final: ParameterForm renders this and no lane edits that file after C0.
 */
import type { NodeProperty } from '@workflow/workflow';
import type { ReactElement } from 'react';
import type { ParameterPath } from '../../lib/workflow-ops';

export interface ResourceMapperInputProps {
  prop: NodeProperty;
  value: unknown;
  onChange: (value: unknown) => void;
  id: string;
  path: ParameterPath;
}

export function ResourceMapperInput(_props: ResourceMapperInputProps): ReactElement {
  throw new Error('not implemented (L6)');
}
