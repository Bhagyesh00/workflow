/** The steps to get an evaluation running, checked from the saved workflow (P5-11). */
import { EVALUATION_NODE_TYPE, EVALUATION_TRIGGER_TYPE, type WorkflowNode } from '@workflow/workflow';
import { CheckCircle2, Circle } from 'lucide-react';
import { Link } from 'react-router';

export interface SetupSteps {
  trigger: boolean;
  outputs: boolean;
  metrics: boolean;
  ran: boolean;
}

/** which setup steps the workflow's nodes already cover */
export function setupSteps(nodes: WorkflowNode[], hasRuns: boolean): SetupSteps {
  const evaluation = nodes.filter((n) => n.type === EVALUATION_NODE_TYPE && !n.disabled);
  const operationOf = (n: WorkflowNode) => String(n.parameters.operation ?? 'setOutputs');
  return {
    trigger: nodes.some((n) => n.type === EVALUATION_TRIGGER_TYPE),
    outputs: evaluation.some((n) => operationOf(n) === 'setOutputs'),
    metrics: evaluation.some((n) => operationOf(n) === 'setMetrics'),
    ran: hasRuns,
  };
}

const ITEMS: Array<{ key: keyof SetupSteps; title: string; text: string }> = [
  {
    key: 'trigger',
    title: 'Add an Evaluation Trigger',
    text: 'It reads the rows of a data table or a Google Sheet, one row for each test case.',
  },
  {
    key: 'outputs',
    title: 'Write the results with Set Outputs',
    text: 'Add an Evaluation node set to Set Outputs after the part you want to test.',
  },
  {
    key: 'metrics',
    title: 'Score each case with Set Metrics',
    text: 'Add an Evaluation node set to Set Metrics. Its numbers become the columns and the chart.',
  },
  {
    key: 'ran',
    title: 'Run the test',
    text: 'Run the workflow against the dataset and compare the scores between runs.',
  },
];

export function SetupGuide({ steps, workflowId }: { steps: SetupSteps; workflowId: string }) {
  return (
    <section
      aria-labelledby="eval-setup"
      className="rounded-xl border border-line bg-surface p-5 shadow-card"
    >
      <h2 id="eval-setup" className="font-display text-md font-semibold text-ink">
        Set up evaluations
      </h2>
      <p className="mt-1 text-sm text-ink-2">
        An evaluation runs your workflow once for every row of a dataset and scores each result.
      </p>
      <ol className="mt-4 flex flex-col gap-3" aria-label="Setup steps">
        {ITEMS.map((item) => {
          const done = steps[item.key];
          return (
            <li key={item.key} className="flex items-start gap-3" data-done={done ? 'true' : 'false'}>
              {done ? (
                <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-ok" aria-label="Done" />
              ) : (
                <Circle size={18} className="mt-0.5 shrink-0 text-ink-3" aria-label="Not done" />
              )}
              <div>
                <p className="text-sm font-semibold text-ink">{item.title}</p>
                <p className="text-sm text-ink-2">{item.text}</p>
              </div>
            </li>
          );
        })}
      </ol>
      {!steps.trigger && (
        <Link
          to={`/workflow/${encodeURIComponent(workflowId)}`}
          className="mt-4 inline-block text-sm font-semibold text-brand hover:underline"
        >
          Open the workflow
        </Link>
      )}
    </section>
  );
}
