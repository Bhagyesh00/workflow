/** Settings tab of the node details view: behaviour on errors, retries, notes and colour. */
import type { NodeTypeDescription, OnErrorBehavior, WorkflowNode } from '@workflow/workflow';
import { useId } from 'react';
import { ParameterList } from '../parameters/ParameterForm';
import { NodeTelemetryTags } from '../telemetry/NodeTelemetryTags';
import { cx } from '../ui/cx';
import { Select, Switch } from '../ui/Field';

const ON_ERROR: Array<{ value: OnErrorBehavior; label: string; hint: string }> = [
  {
    value: 'stopWorkflow',
    label: 'Stop the workflow',
    hint: 'The execution fails and the error workflow runs.',
  },
  {
    value: 'continueRegularOutput',
    label: 'Continue with the error as output',
    hint: 'The node outputs an item with the error message.',
  },
  {
    value: 'continueErrorOutput',
    label: 'Continue on a separate error output',
    hint: 'Failed items leave through an extra “Error” output.',
  },
];

const COLORS = ['#3d63dd', '#d1453b', '#0f8a6c', '#c27a00', '#7c4dcc', '#0e7f9e', '#c2387a'];

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {label}
      </label>
      {children(id)}
      {hint && <p className="text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} checked={checked} onChange={onChange} label={label} disabled={disabled} />
      <div>
        <label htmlFor={id} className="text-sm font-semibold text-ink">
          {label}
        </label>
        {hint && <p className="text-xs text-ink-3">{hint}</p>}
      </div>
    </div>
  );
}

export function NodeSettingsForm({
  node,
  description,
  readOnly,
  onChange,
  onTagsInvalid,
}: {
  node: WorkflowNode;
  description?: NodeTypeDescription;
  readOnly: boolean;
  onChange: (patch: Partial<Omit<WorkflowNode, 'name' | 'id'>>) => void;
  /** true while a telemetry attribute row is invalid (P6-67) */
  onTagsInvalid?: (invalid: boolean) => void;
}) {
  const settingProps = description?.properties.filter((p) => p.isNodeSetting) ?? [];
  const onError = node.onError ?? 'stopWorkflow';
  return (
    <div className="flex flex-col gap-5">
      <ToggleRow
        label="Always output data"
        hint="Emit one empty item when the node returns nothing, so the following nodes still run."
        checked={Boolean(node.alwaysOutputData)}
        onChange={(v) => onChange({ alwaysOutputData: v || undefined })}
        disabled={readOnly}
      />
      <ToggleRow
        label="Execute once"
        hint="Run only for the first input item."
        checked={Boolean(node.executeOnce)}
        onChange={(v) => onChange({ executeOnce: v || undefined })}
        disabled={readOnly}
      />
      <ToggleRow
        label="Retry on fail"
        checked={Boolean(node.retryOnFail)}
        onChange={(v) => onChange({ retryOnFail: v || undefined })}
        disabled={readOnly}
      />
      {node.retryOnFail && (
        <div className="grid grid-cols-2 gap-3 rounded-xl border border-line bg-surface-2 p-3 [&>*:nth-child(3)]:col-span-2">
          <Row label="Max tries" hint="Between 2 and 5">
            {(id) => (
              <input
                id={id}
                type="number"
                min={2}
                max={5}
                className="wf-field"
                readOnly={readOnly}
                value={node.maxTries ?? 3}
                onChange={(e) =>
                  onChange({ maxTries: Math.min(5, Math.max(2, Number(e.target.value) || 3)) })
                }
              />
            )}
          </Row>
          <Row label="Wait between tries (ms)" hint="Up to 5000 ms">
            {(id) => (
              <input
                id={id}
                type="number"
                min={0}
                max={5000}
                step={100}
                className="wf-field"
                readOnly={readOnly}
                value={node.waitBetweenTries ?? 1000}
                onChange={(e) =>
                  onChange({ waitBetweenTries: Math.min(5000, Math.max(0, Number(e.target.value) || 0)) })
                }
              />
            )}
          </Row>
          <Row label="Backoff" hint="Exponential doubles the wait each attempt and honours Retry-After">
            {(id) => (
              <Select
                id={id}
                value={node.retryBackoff ?? 'fixed'}
                disabled={readOnly}
                onChange={(e) =>
                  onChange({ retryBackoff: e.target.value === 'exponential' ? 'exponential' : undefined })
                }
              >
                <option value="fixed">Fixed wait</option>
                <option value="exponential">Exponential with jitter</option>
              </Select>
            )}
          </Row>
        </div>
      )}
      <Row label="On error" hint={ON_ERROR.find((o) => o.value === onError)?.hint}>
        {(id) => (
          <Select
            id={id}
            value={onError}
            disabled={readOnly}
            onChange={(e) => {
              const value = e.target.value as OnErrorBehavior;
              onChange({ onError: value === 'stopWorkflow' ? undefined : value });
            }}
          >
            {ON_ERROR.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
      </Row>
      {settingProps.length > 0 && (
        <ParameterList properties={settingProps} values={node.parameters} path={[]} />
      )}
      {/* P6-67 (L11): custom OpenTelemetry attributes of this node's spans (expressions over item 0) */}
      <NodeTelemetryTags
        node={node}
        onChange={onChange}
        readOnly={readOnly}
        onValidityChange={onTagsInvalid}
      />
      <Row label="Notes">
        {(id) => (
          <textarea
            id={id}
            className="wf-field resize-y"
            rows={3}
            readOnly={readOnly}
            value={node.notes ?? ''}
            placeholder="What does this node do, and why?"
            onChange={(e) => onChange({ notes: e.target.value || undefined })}
          />
        )}
      </Row>
      <ToggleRow
        label="Show notes on the canvas"
        checked={Boolean(node.notesInFlow)}
        onChange={(v) => onChange({ notesInFlow: v || undefined })}
        disabled={readOnly}
      />
      <fieldset className="flex flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1.5 text-sm font-semibold text-ink">Colour</legend>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={!node.color}
            disabled={readOnly}
            onClick={() => onChange({ color: undefined })}
            className={cx(
              'h-6 rounded-full border border-line px-2 text-2xs font-semibold text-ink-2',
              !node.color && 'ring-2 ring-brand',
            )}
          >
            Default
          </button>
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-pressed={node.color === color}
              aria-label={`Colour ${color}`}
              disabled={readOnly}
              onClick={() => onChange({ color })}
              className={cx(
                'size-6 rounded-full',
                node.color === color && 'ring-2 ring-brand ring-offset-2 ring-offset-surface',
              )}
              style={{ background: color }}
            />
          ))}
        </div>
      </fieldset>
    </div>
  );
}
