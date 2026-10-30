/** Floating run controls: execute, stop, listen state, clear results, logs toggle. */
import { Copy, Eraser, Play, Radio, Square, Terminal } from 'lucide-react';
import { Button, IconButton } from '../../components/ui/Button';
import { StatusBadge } from '../../components/ui/misc';
import { formatDuration } from '../../lib/format';
import { useRunStore } from '../../stores/run-store';
import { toast, useUiStore } from '../../stores/ui-store';

export function ExecuteBar({
  onExecute,
  onStop,
  readOnly,
  listenNode,
}: {
  onExecute: () => void;
  onStop: () => void;
  readOnly: boolean;
  /** set when "Execute workflow" means listening on this webhook trigger */
  listenNode: string | null;
}) {
  const status = useRunStore((s) => s.status);
  const runData = useRunStore((s) => s.runData);
  const testWebhook = useRunStore((s) => s.testWebhook);
  const startedAt = useRunStore((s) => s.startedAt);
  const finishedAt = useRunStore((s) => s.finishedAt);
  const logs = useRunStore((s) => s.logs.length);
  const reset = useRunStore((s) => s.reset);
  const logPanelOpen = useUiStore((s) => s.logPanelOpen);
  const setLogPanel = useUiStore((s) => s.setLogPanel);
  const busy = status === 'starting' || status === 'running';
  const hasResults = Object.keys(runData).length > 0;
  const finished =
    status === 'success' || status === 'error' || status === 'canceled' || status === 'crashed';

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 z-10 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2 rounded-2xl border border-line bg-surface/95 p-1.5 shadow-lift backdrop-blur">
        {status === 'listening' && testWebhook ? (
          <>
            <span className="flex items-center gap-2 pl-2 text-sm">
              <Radio size={15} className="text-brand" />
              <span className="font-semibold">Waiting for a call to</span>
              <code
                className="max-w-72 truncate rounded bg-surface-3 px-1.5 py-0.5 text-xs"
                title={testWebhook.testUrl}
              >
                {testWebhook.testUrl}
              </code>
            </span>
            <IconButton
              label="Copy test URL"
              size="sm"
              onClick={() =>
                void navigator.clipboard?.writeText(testWebhook.testUrl).then(
                  () => toast.success('Test URL copied'),
                  () => undefined,
                )
              }
            >
              <Copy size={13} />
            </IconButton>
            <Button size="md" onClick={onStop} icon={<Square size={13} />}>
              Stop listening
            </Button>
          </>
        ) : busy ? (
          <>
            <span className="pl-2">
              <StatusBadge status="running" />
            </span>
            <Button size="lg" variant="danger" onClick={onStop} icon={<Square size={14} />}>
              Stop
            </Button>
          </>
        ) : (
          <>
            {finished && (
              <span className="flex items-center gap-2 pl-2 text-xs text-ink-2">
                <StatusBadge status={status} />
                {startedAt && finishedAt ? formatDuration(finishedAt - startedAt) : null}
              </span>
            )}
            <Button
              size="lg"
              variant="primary"
              onClick={onExecute}
              disabled={readOnly}
              icon={listenNode ? <Radio size={16} /> : <Play size={16} />}
            >
              {listenNode ? 'Listen for test event' : 'Execute workflow'}
            </Button>
            {hasResults && (
              <IconButton label="Clear run data" onClick={reset}>
                <Eraser size={16} />
              </IconButton>
            )}
          </>
        )}
        <IconButton
          label={logPanelOpen ? 'Hide logs' : 'Show logs'}
          active={logPanelOpen}
          onClick={() => setLogPanel(!logPanelOpen)}
        >
          <span className="relative">
            <Terminal size={16} />
            {logs > 0 && !logPanelOpen && (
              <span className="absolute -top-1 -right-1 size-2 rounded-full bg-brand" />
            )}
          </span>
        </IconButton>
      </div>
    </div>
  );
}
