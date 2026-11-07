/**
 * "Let the model define this parameter" around one input (P5-75). A parameter the model defines holds
 * a `$fromAI` expression written by `buildFromAiOverride`; the panel replaces the input while it does.
 * The node and the read-only state come from `useParameterContext()`.
 */
import type { NodeProperty } from '@workflow/workflow';
import { Sparkles } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import {
  buildFromAiOverride,
  canUseFromAiOverride,
  fromAiKeyFromPath,
  fromAiTypeOf,
  parseFromAiOverride,
} from '../../lib/from-ai-override';
import type { ParameterPath } from '../../lib/workflow-ops';
import { useParameterContext } from './context';

export interface FromAiOverrideProps {
  prop: NodeProperty;
  value: unknown;
  path: ParameterPath;
  onChange: (next: unknown) => void;
  children: ReactNode;
}

function isLocator(value: unknown): value is { __rl: true; mode?: string; value?: unknown } {
  return Boolean(value) && typeof value === 'object' && Boolean((value as { __rl?: unknown }).__rl);
}

/** the value the parameter has again once the model no longer defines it */
function fixedValue(prop: NodeProperty, current: unknown): unknown {
  if (prop.type === 'resourceLocator') {
    const mode = isLocator(current) && current.mode ? current.mode : 'id';
    return { __rl: true, mode, value: '' };
  }
  if (prop.default !== undefined && prop.default !== null) return prop.default;
  if (prop.type === 'boolean') return false;
  if (prop.type === 'number') return 0;
  return '';
}

export function FromAiOverride({ prop, value, path, onChange, children }: FromAiOverrideProps) {
  const ctx = useParameterContext();
  const descriptionId = useId();
  const parsed = parseFromAiOverride(value);

  if (parsed) {
    const write = (description: string) => {
      const text = buildFromAiOverride({ ...parsed, description });
      onChange(isLocator(value) ? { ...value, value: text } : text);
    };
    return (
      <section
        aria-label="Defined by agent"
        data-testid="from-ai-panel"
        className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3"
      >
        <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Sparkles size={13} className="text-brand" aria-hidden="true" />
          Defined by agent
        </div>
        <label htmlFor={descriptionId} className="text-xs text-ink-2">
          Description
        </label>
        <input
          id={descriptionId}
          type="text"
          value={parsed.description}
          disabled={ctx.readOnly}
          placeholder="Tell the model what to put here"
          onChange={(event) => write(event.target.value)}
          className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-ink"
        />
        {!ctx.readOnly && (
          <button
            type="button"
            onClick={() => onChange(fixedValue(prop, value))}
            className="self-start rounded-md px-2 py-1 text-xs font-semibold text-brand hover:bg-surface-3"
          >
            Edit value
          </button>
        )}
      </section>
    );
  }

  if (ctx.readOnly || !canUseFromAiOverride(ctx.description, prop, path)) return <>{children}</>;

  const define = () => {
    const text = buildFromAiOverride({
      key: fromAiKeyFromPath(path),
      description: '',
      type: fromAiTypeOf(prop),
    });
    if (isLocator(value)) onChange({ ...value, value: text });
    else if (prop.type === 'resourceLocator') onChange({ __rl: true, mode: 'id', value: text });
    else onChange(text);
  };
  return (
    <>
      {children}
      <button
        type="button"
        onClick={define}
        className="inline-flex items-center gap-1 self-start rounded-md px-1.5 py-0.5 text-2xs font-semibold text-ink-3 hover:bg-surface-3 hover:text-brand"
      >
        <Sparkles size={11} aria-hidden="true" />
        Let the model define this parameter
      </button>
    </>
  );
}
