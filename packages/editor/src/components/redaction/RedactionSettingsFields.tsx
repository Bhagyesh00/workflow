/**
 * P6-53 (L8): workflow settings fields: redact production runs, manual runs, and callers' copies
 * (`redactionPolicy`, `redactCallerExecutions`); never weaker than the workspace floor.
 */

import {
  floorToChannels,
  type RedactionChannels,
  type RedactionPolicy,
  type WorkflowSettings,
} from '@workflow/workflow';
import type { ReactNode } from 'react';
import { useSettings } from '../../api/queries';
import { Switch } from '../ui/Field';

export interface RedactionSettingsFieldsProps {
  /** the settings being edited (saved by the modal) */
  draft: WorkflowSettings;
  /** merges a patch into `draft` */
  set(patch: Partial<WorkflowSettings>): void;
}

function channelsOf(policy: RedactionPolicy | undefined): RedactionChannels {
  return {
    production: policy === 'all' || policy === 'non-manual',
    manual: policy === 'all' || policy === 'manual-only',
  };
}

/** manual runs can only be redacted together with production runs (the legacy `manual-only` is read, never set) */
function policyOf(channels: RedactionChannels): RedactionPolicy {
  if (channels.production) return channels.manual ? 'all' : 'non-manual';
  return channels.manual ? 'manual-only' : 'none';
}

export function RedactionSettingsFields({ draft, set }: RedactionSettingsFieldsProps): ReactNode {
  const floor = floorToChannels(useSettings().redactionFloor);
  const own = channelsOf(draft.redactionPolicy);
  const shown: RedactionChannels = {
    production: own.production || floor.production,
    manual: own.manual || floor.manual,
  };
  const change = (patch: Partial<RedactionChannels>) => {
    const next = { ...shown, ...patch };
    if (!next.production) next.manual = false;
    set({ redactionPolicy: policyOf(next) });
  };
  const floored = floor.production || floor.manual;
  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border border-line p-3">
      <legend className="px-1 text-sm font-semibold">Redact execution data</legend>
      <p className="text-xs text-ink-3">
        A redacted execution shows no item data. Members who can reveal it see why and can reveal it; the
        reveal is logged.
        {floored && ' The workspace floor decides the least a workflow may redact.'}
      </p>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">Redact production runs</span>
        <Switch
          label="Redact production runs"
          checked={shown.production}
          disabled={floor.production}
          onChange={(v) => change({ production: v })}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">Redact manual runs (needs production runs)</span>
        <Switch
          label="Redact manual runs"
          checked={shown.manual}
          disabled={floor.manual || !shown.production}
          onChange={(v) => change({ manual: v })}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">Redact the copy a calling workflow keeps of this one's output</span>
        <Switch
          label="Redact callers' copies"
          checked={draft.redactCallerExecutions !== false}
          onChange={(v) => set({ redactCallerExecutions: v })}
        />
      </div>
    </fieldset>
  );
}
