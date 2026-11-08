/** P5-63: switches the builder between build and plan mode (`useBuilderStore` `mode`). */
import { useBuilderStore } from '../../stores/builder-store';
import { Switch } from '../ui/Field';

export function PlanModeToggle() {
  const mode = useBuilderStore((s) => s.mode);
  const streaming = useBuilderStore((s) => s.streaming);
  const setMode = useBuilderStore((s) => s.setMode);
  return (
    <div
      className="flex items-center gap-2 text-xs text-ink-2"
      title="Plan mode asks questions and proposes a plan before it changes the canvas"
    >
      <Switch
        size="sm"
        label="Plan mode"
        checked={mode === 'plan'}
        disabled={streaming}
        onChange={(on) => setMode(on ? 'plan' : 'build')}
      />
      <span aria-hidden="true">Plan first</span>
    </div>
  );
}
