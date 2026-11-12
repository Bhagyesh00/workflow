/** P6-67 (L11): project settings slot: `customTelemetryTags`, `project.custom.<key>` on the project's spans. */
import type { ReactNode } from 'react';
import { TelemetryTagsField, type TelemetryTagsFieldProps } from './TelemetryTagsField';

export type ProjectTelemetryTagsProps = TelemetryTagsFieldProps;

export function ProjectTelemetryTags(props: ProjectTelemetryTagsProps): ReactNode {
  return (
    <TelemetryTagsField
      hint="Added to the spans of this project's workflows as project.custom.<key> when the workspace sends traces."
      {...props}
    />
  );
}
