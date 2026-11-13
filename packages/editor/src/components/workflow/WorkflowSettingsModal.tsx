/** Workflow settings: timezone, error workflow, timeout, what to save, who may call it. */
import { useQuery } from '@tanstack/react-query';
import type { CallerPolicy, WorkflowSettings } from '@workflow/workflow';
import { useEffect, useMemo, useState } from 'react';
import { workflowsApi } from '../../api/endpoints';
import { useSettings } from '../../api/queries';
import { RedactionSettingsFields } from '../redaction/RedactionSettingsFields';
import { WorkflowTelemetryTags } from '../telemetry/WorkflowTelemetryTags';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { FormField, Select, Switch, TextInput } from '../ui/Field';
import { TimeSavedFields } from './TimeSavedFields';

function timezones(): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    return intl.supportedValuesOf?.('timeZone') ?? ['UTC'];
  } catch {
    return ['UTC'];
  }
}

const CALLER_POLICIES: Array<{ value: CallerPolicy; label: string }> = [
  { value: 'sameProject', label: 'Workflows in the same project' },
  { value: 'any', label: 'Any workflow in this workspace, from any project' },
  { value: 'allowList', label: 'Only the workflows listed below' },
  { value: 'none', label: 'No other workflow' },
];

export function WorkflowSettingsModal({
  open,
  onClose,
  value,
  workflowId,
  onSave,
  readOnly,
}: {
  open: boolean;
  onClose: () => void;
  value: WorkflowSettings;
  workflowId?: string;
  onSave: (settings: WorkflowSettings) => void;
  readOnly: boolean;
}) {
  const settings = useSettings();
  const [draft, setDraft] = useState<WorkflowSettings>(value);
  // P6-67: a telemetry attribute row is invalid; the draft holds the last valid list, so Apply waits
  const [tagsInvalid, setTagsInvalid] = useState(false);
  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);
  const workflows = useQuery({
    queryKey: ['workflows', 'settings-picker'],
    queryFn: () => workflowsApi.list({ limit: 200 }),
    enabled: open,
  });
  const zones = useMemo(timezones, []);
  const maxTimeout =
    Number(settings.limits?.executionTimeoutMax ?? settings.limits?.maxExecutionTimeout ?? 0) || undefined;
  const set = (patch: Partial<WorkflowSettings>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Workflow settings"
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={readOnly || tagsInvalid}
            onClick={() => {
              onSave(draft);
              onClose();
            }}
          >
            Apply settings
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <FormField
          label="Timezone"
          hint={`Used by schedules and date expressions. The workspace default is ${settings.timezone}.`}
        >
          {(id) => (
            <Select
              id={id}
              value={draft.timezone ?? ''}
              onChange={(e) => set({ timezone: e.target.value || undefined })}
            >
              <option value="">Workspace default ({settings.timezone})</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="Error workflow" hint="Runs when a production execution of this workflow fails.">
          {(id) => (
            <Select
              id={id}
              value={draft.errorWorkflow ?? ''}
              onChange={(e) => set({ errorWorkflow: e.target.value || undefined })}
            >
              <option value="">None</option>
              {(workflows.data?.data ?? [])
                .filter((w) => w.id !== workflowId)
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
            </Select>
          )}
        </FormField>
        <FormField
          label="Timeout (seconds)"
          hint={`0 uses the workspace default${maxTimeout ? `; the maximum is ${maxTimeout}` : ''}.`}
        >
          {(id) => (
            <TextInput
              id={id}
              type="number"
              min={0}
              max={maxTimeout}
              value={draft.executionTimeout ?? 0}
              onChange={(e) => {
                const n = Math.max(0, Math.floor(Number(e.target.value) || 0));
                set({ executionTimeout: n ? (maxTimeout ? Math.min(n, maxTimeout) : n) : undefined });
              }}
            />
          )}
        </FormField>
        <fieldset className="flex flex-col gap-3 rounded-xl border border-line p-3">
          <legend className="px-1 text-sm font-semibold">Execution history</legend>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Failed runs">
              {(id) => (
                <Select
                  id={id}
                  value={draft.saveDataErrorExecution ?? 'all'}
                  onChange={(e) => set({ saveDataErrorExecution: e.target.value as 'all' | 'none' })}
                >
                  <option value="all">Save</option>
                  <option value="none">Do not save</option>
                </Select>
              )}
            </FormField>
            <FormField label="Successful runs">
              {(id) => (
                <Select
                  id={id}
                  value={draft.saveDataSuccessExecution ?? 'all'}
                  onChange={(e) => set({ saveDataSuccessExecution: e.target.value as 'all' | 'none' })}
                >
                  <option value="all">Save</option>
                  <option value="none">Do not save</option>
                </Select>
              )}
            </FormField>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">Save manual runs from the editor</span>
            <Switch
              label="Save manual runs"
              checked={draft.saveManualExecutions ?? true}
              onChange={(v) => set({ saveManualExecutions: v })}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">Save progress after each node, so a crashed run can resume</span>
            <Switch
              label="Save execution progress"
              checked={Boolean(draft.saveExecutionProgress)}
              onChange={(v) => set({ saveExecutionProgress: v || undefined })}
            />
          </div>
        </fieldset>
        {/* P6-53 (L8): redact production runs, manual runs and callers' copies */}
        <RedactionSettingsFields draft={draft} set={set} />
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Available in MCP</p>
            <p className="text-xs text-ink-2">
              MCP clients of this workspace can find, read and run this workflow, once an admin turns MCP on.
            </p>
          </div>
          <Switch
            label="Available in MCP"
            checked={draft.availableInMCP === true}
            disabled={readOnly}
            onChange={(v) => set({ availableInMCP: v })}
          />
        </div>
        <FormField
          label="Who can call this workflow"
          hint="Applies to other workflows that run it as a sub-workflow. Not set means the same project."
        >
          {(id) => (
            <Select
              id={id}
              value={draft.callerPolicy ?? 'sameProject'}
              onChange={(e) => set({ callerPolicy: e.target.value as CallerPolicy })}
            >
              {CALLER_POLICIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        {draft.callerPolicy === 'allowList' && (
          <FormField label="Allowed workflow ids" hint="Separate ids with commas.">
            {(id) => (
              <TextInput
                id={id}
                value={(draft.callerIds ?? []).join(', ')}
                onChange={(e) =>
                  set({
                    callerIds: e.target.value
                      .split(',')
                      .map((v) => v.trim())
                      .filter(Boolean),
                  })
                }
              />
            )}
          </FormField>
        )}
        {/* P6-56 (L12): time saved per run, fixed or from Track Time Saved nodes */}
        <TimeSavedFields draft={draft} set={set} />
        {/* P6-67 (L11): custom OpenTelemetry attributes of this workflow's spans */}
        <WorkflowTelemetryTags draft={draft} set={set} onValidityChange={setTagsInvalid} />
      </div>
    </Dialog>
  );
}
