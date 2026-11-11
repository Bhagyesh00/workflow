/**
 * P6-53 (L8): workflow settings fields: redact production runs, manual runs, and callers' copies
 * (`redactionPolicy`, `redactCallerExecutions`); never weaker than the workspace floor. A switch whose
 * change would raise the saved setting needs `workflow:enableRedaction` on the open workflow, one that
 * would lower it `workflow:disableRedaction` (as the server judges a save); turning a switch back is free.
 */

import {
  floorToChannels,
  type RedactionChannels,
  type RedactionPolicy,
  type WorkflowSettings,
} from '@workflow/workflow';
import { type ReactNode, useState } from 'react';
import { useSettings } from '../../api/queries';
import { useOpenWorkflowCan, useOpenWorkflowStore } from '../../features/editor/open-resources';
import { useWorkflowStore } from '../../stores/workflow-store';
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

/** the channels and the callers' copy a setting redacts */
type Redacts = RedactionChannels & { callers: boolean };

const redactsOf = (settings: WorkflowSettings): Redacts => ({
  ...channelsOf(settings.redactionPolicy),
  callers: settings.redactCallerExecutions !== false,
});

export function RedactionSettingsFields({ draft, set }: RedactionSettingsFieldsProps): ReactNode {
  const floor = floorToChannels(useSettings().redactionFloor);
  const can = useOpenWorkflowCan();
  // a workflow not saved yet has no scopes of its own: the server judges it in its project on the first save
  const openId = useOpenWorkflowStore((s) => s.id);
  const workflowId = useWorkflowStore((s) => s.meta.id);
  const known = Boolean(openId && openId === workflowId);
  const may = (scope: 'workflow:enableRedaction' | 'workflow:disableRedaction') => !known || can(scope);
  // what the workflow had when the fields opened: the server judges a save against it
  const [saved] = useState(() => redactsOf(draft));
  const own = channelsOf(draft.redactionPolicy);
  const shown: RedactionChannels = {
    production: own.production || floor.production,
    manual: own.manual || floor.manual,
  };
  const nextOf = (patch: Partial<RedactionChannels>): RedactionChannels => {
    const next = { ...shown, ...patch };
    if (!next.production) next.manual = false;
    return next;
  };
  const change = (patch: Partial<RedactionChannels>) => set({ redactionPolicy: policyOf(nextOf(patch)) });
  /** whether the user may move the setting from `saved` to `after` */
  const allowed = (after: Redacts) => {
    const keys = ['production', 'manual', 'callers'] as const;
    const raising = keys.some((key) => after[key] && !saved[key]);
    const lowering = keys.some((key) => !after[key] && saved[key]);
    return (!raising || may('workflow:enableRedaction')) && (!lowering || may('workflow:disableRedaction'));
  };
  const callers = draft.redactCallerExecutions !== false;
  const flip = (patch: Partial<RedactionChannels>) =>
    allowed({ ...channelsOf(policyOf(nextOf(patch))), callers });
  const productionOk = flip({ production: !shown.production });
  const manualOk = flip({ manual: !shown.manual });
  const callersOk = allowed({ ...own, callers: !callers });
  const locked = !productionOk || !manualOk || !callersOk;
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
          disabled={floor.production || !productionOk}
          onChange={(v) => change({ production: v })}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">Redact manual runs (needs production runs)</span>
        <Switch
          label="Redact manual runs"
          checked={shown.manual}
          disabled={floor.manual || !shown.production || !manualOk}
          onChange={(v) => change({ manual: v })}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">Redact the copy a calling workflow keeps of this one's output</span>
        <Switch
          label="Redact callers' copies"
          checked={callers}
          disabled={!callersOk}
          onChange={(v) => set({ redactCallerExecutions: v })}
        />
      </div>
      {locked && <p className="text-xs text-ink-3">You need permission to change data redaction.</p>}
    </fieldset>
  );
}
