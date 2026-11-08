/** P5-63: a plan from plan mode, with Approve, Modify and Reject. Every field shows as text. */
import type { BuilderPlan } from '@workflow/workflow';
import { useState } from 'react';
import { decidePlan } from '../../features/builder/plan-actions';
import { useBuilderStore } from '../../stores/builder-store';
import { Button } from '../ui/Button';
import { TextArea } from '../ui/Field';
import { Badge } from '../ui/misc';

export interface PlanMessageProps {
  plan: BuilderPlan;
}

export function PlanMessage({ plan }: PlanMessageProps) {
  const streaming = useBuilderStore((s) => s.streaming);
  const [modifying, setModifying] = useState(false);
  const [feedback, setFeedback] = useState('');

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-3" aria-label="Plan">
      <div>
        <p className="text-xs font-semibold tracking-wide text-ink-2 uppercase">Plan</p>
        <p className="mt-1 text-sm font-semibold">{plan.summary}</p>
      </div>
      {plan.trigger && (
        <p className="text-sm">
          <span className="font-semibold">Starts: </span>
          {plan.trigger}
        </p>
      )}
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
        {plan.steps.map((step, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a plan is shown as sent and never reorders
          <li key={i}>
            <span>{step.description}</span>
            {step.nodeTypes && step.nodeTypes.length > 0 && (
              <span className="mt-1 flex flex-wrap gap-1">
                {step.nodeTypes.map((type) => (
                  <Badge key={type}>{type}</Badge>
                ))}
              </span>
            )}
          </li>
        ))}
      </ol>
      {plan.notes && plan.notes.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-ink-2">
          {plan.notes.map((note, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: notes are shown as sent
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}
      {modifying ? (
        <div className="flex flex-col gap-2">
          <TextArea
            rows={3}
            maxLength={5000}
            aria-label="What should change in the plan"
            placeholder="What should change?"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setModifying(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={streaming || !feedback.trim()}
              onClick={() => void decidePlan('modify', feedback)}
            >
              Send changes
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={streaming} onClick={() => void decidePlan('reject')}>
            Reject
          </Button>
          <Button size="sm" variant="secondary" disabled={streaming} onClick={() => setModifying(true)}>
            Modify
          </Button>
          <Button size="sm" variant="primary" disabled={streaming} onClick={() => void decidePlan('approve')}>
            Approve
          </Button>
        </div>
      )}
    </section>
  );
}
