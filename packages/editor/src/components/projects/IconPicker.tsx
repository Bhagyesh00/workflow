/** P6-42: pick a project's icon, an emoji or a named icon. */
import type { ProjectIcon } from '../../api/types';

export interface IconPickerProps {
  value: ProjectIcon | null;
  onChange(icon: ProjectIcon): void;
  disabled?: boolean;
}

export function IconPicker(_props: IconPickerProps) {
  // stub (L19)
  return null;
}
