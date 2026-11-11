/**
 * P6-56 (L12): workflow settings fields: time saved per run, Fixed (`timeSavedPerExecution`) or
 * Dynamic (Track Time Saved nodes); the notices read the open workflow's nodes from `useWorkflowStore`.
 */

import type { WorkflowSettings } from '@workflow/workflow';
import type { ReactNode } from 'react';
import { useWorkflowStore } from '../../stores/workflow-store';
import { FormField, TextInput } from '../ui/Field';
import { Callout } from '../ui/misc';
import { Tabs } from '../ui/Tabs';

export interface TimeSavedFieldsProps {
  /** the settings being edited (saved by the modal) */
  draft: WorkflowSettings;
  /** merges a patch into `draft` */
  set(patch: Partial<WorkflowSettings>): void;
}

type Mode = NonNullable<WorkflowSettings['timeSavedMode']>;

const TIME_SAVED_TYPE = 'core.timeSaved';

export function TimeSavedFields({ draft, set }: TimeSavedFieldsProps): ReactNode {
  // the modal opens only in the editor, so the open workflow's nodes are in the store
  const count = useWorkflowStore(
    (s) => s.nodes.filter((n) => n.type === TIME_SAVED_TYPE && !n.disabled).length,
  );
  const mode: Mode = draft.timeSavedMode === 'dynamic' ? 'dynamic' : 'fixed';
  const minutes = draft.timeSavedPerExecution;
  const onMinutes = (raw: string) => {
    if (raw.trim() === '') return set({ timeSavedPerExecution: undefined });
    const value = Math.floor(Number(raw));
    if (Number.isFinite(value) && value >= 0) set({ timeSavedPerExecution: value });
  };
  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border border-line p-3">
      <legend className="px-1 text-sm font-semibold">Time saved per run</legend>
      <p className="text-xs text-ink-3">
        Insights adds this to the time saved for each successful production run of the workflow.
      </p>
      <Tabs<Mode>
        label="Time saved mode"
        size="sm"
        value={mode}
        onChange={(value) => set({ timeSavedMode: value })}
        items={[
          { value: 'fixed', label: 'Fixed' },
          { value: 'dynamic', label: 'Dynamic' },
        ]}
      />
      {mode === 'fixed' ? (
        <>
          <FormField label="Minutes saved per run" hint="A whole number, 0 or more">
            {(id) => (
              <TextInput
                id={id}
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                value={minutes ?? ''}
                onChange={(e) => onMinutes(e.target.value)}
              />
            )}
          </FormField>
          {count > 0 && (
            <Callout tone="warn" title="Track Time Saved nodes are ignored">
              This workflow has {count} Track Time Saved {count === 1 ? 'node' : 'nodes'}. In Fixed mode their
              minutes are not counted. Switch to Dynamic to use them.
            </Callout>
          )}
        </>
      ) : count > 0 ? (
        <Callout tone="info">
          The minutes of {count} Track Time Saved {count === 1 ? 'node' : 'nodes'} are added up for each
          successful run. The fixed number is not used.
        </Callout>
      ) : (
        <Callout tone="warn" title="No Track Time Saved node">
          This workflow has no Track Time Saved node, so a run saves no time. Add one where the work is done,
          or switch to Fixed.
        </Callout>
      )}
    </fieldset>
  );
}
