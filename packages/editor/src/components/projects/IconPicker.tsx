/** P6-42: pick a project's icon, an emoji or a named icon. */
import type { ProjectIcon } from '../../api/types';
import { cx } from '../ui/cx';
import { ProjectIconView } from './ProjectNav';

export interface IconPickerProps {
  value: ProjectIcon | null;
  onChange(icon: ProjectIcon): void;
  disabled?: boolean;
}

/** the named icons `ProjectIconView` draws */
export const PROJECT_ICON_NAMES = [
  'layers',
  'folder',
  'briefcase',
  'home',
  'rocket',
  'star',
  'users',
  'user',
];

const EMOJIS = ['🚀', '📁', '💼', '🏠', '⭐', '🧪', '📊', '🛠️', '🔒', '💡', '📦', '🎯'];

export function IconPicker({ value, onChange, disabled }: IconPickerProps) {
  const pick = (type: ProjectIcon['type'], v: string) => {
    const icon: ProjectIcon = { type, value: v };
    if (value?.color) icon.color = value.color;
    onChange(icon);
  };
  const cell = (selected: boolean) =>
    cx(
      'flex h-9 w-9 items-center justify-center rounded-lg border text-base transition-colors disabled:opacity-50',
      selected ? 'border-brand bg-brand-soft text-brand' : 'border-line text-ink-2 hover:bg-surface-3',
    );
  return (
    <fieldset aria-label="Project icon" className="flex min-w-0 flex-col gap-2 border-0 p-0">
      <div className="flex flex-wrap gap-1.5">
        {PROJECT_ICON_NAMES.map((name) => (
          <button
            key={name}
            type="button"
            disabled={disabled}
            aria-label={`Icon ${name}`}
            aria-pressed={value?.type === 'icon' && value.value === name}
            className={cell(value?.type === 'icon' && value.value === name)}
            onClick={() => pick('icon', name)}
          >
            <ProjectIconView icon={{ type: 'icon', value: name }} type="team" size={16} />
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            disabled={disabled}
            aria-label={`Emoji ${emoji}`}
            aria-pressed={value?.type === 'emoji' && value.value === emoji}
            className={cell(value?.type === 'emoji' && value.value === emoji)}
            onClick={() => pick('emoji', emoji)}
          >
            <span aria-hidden="true">{emoji}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}
