/** P6-43: the project filter of the Overview lists (null = every project). */
export interface ProjectFilterProps {
  value: string | null;
  onChange(projectId: string | null): void;
}

export function ProjectFilter(_props: ProjectFilterProps) {
  // stub (L20)
  return null;
}
