/**
 * P5-67 (L2): one message. Text through `Markdown` (lib/markdown.tsx), never raw HTML; an assistant message
 * shows the tool rows of its calls (name, running, done, failed, details collapsed).
 *
 * `BuilderMessage` (S4) is the pattern: `Markdown` builds React elements, so a model's `<img onerror>` stays
 * text. A tool message has no bubble: its result shows in the row of its call.
 */
import type { AssistantMessageDTO } from '@workflow/workflow';
import { Check, Paperclip, X } from 'lucide-react';
import { Markdown } from '../../lib/markdown';
import type { AssistantToolRun } from '../../stores/assistant-store';
import { cx } from '../ui/cx';
import { Spinner } from '../ui/misc';

export interface AssistantMessageProps {
  message: AssistantMessageDTO;
  /** the rows of this message's tool calls */
  toolRuns?: AssistantToolRun[];
}

const STATE_LABEL: Record<AssistantToolRun['state'], string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
};

/** a tool name as words: `list_workflows` reads "list workflows" */
function toolLabel(name: string): string {
  return name.replace(/[_-]+/g, ' ').trim() || name;
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

/** one tool call: its name and state, the arguments and the answer behind Details */
export function AssistantToolRow({ run }: { run: AssistantToolRun }) {
  const hasArgs = run.args && Object.keys(run.args).length > 0;
  return (
    <li
      className="rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-xs"
      data-tool-call={run.toolCallId}
      data-state={run.state}
    >
      <div className="flex items-center gap-2">
        {run.state === 'running' ? (
          <Spinner size={12} className="text-brand" />
        ) : run.state === 'done' ? (
          <Check size={13} className="text-ok" aria-hidden />
        ) : (
          <X size={13} className="text-err" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate font-medium text-ink">{toolLabel(run.toolName)}</span>
        <span className={cx('shrink-0', run.state === 'failed' ? 'text-err' : 'text-ink-2')}>
          {STATE_LABEL[run.state]}
        </span>
      </div>
      {(hasArgs || run.result !== undefined || run.error !== undefined) && (
        <details className="mt-1">
          <summary className="cursor-pointer text-ink-2 select-none">Details</summary>
          {hasArgs && (
            <>
              <p className="mt-1 font-semibold text-ink-2">Input</p>
              <pre className="wf-scroll max-h-48 overflow-auto rounded bg-surface p-2 whitespace-pre-wrap break-words">
                {pretty(run.args)}
              </pre>
            </>
          )}
          {run.result !== undefined && (
            <>
              <p className="mt-1 font-semibold text-ink-2">Result</p>
              <pre className="wf-scroll max-h-48 overflow-auto rounded bg-surface p-2 whitespace-pre-wrap break-words">
                {run.result}
              </pre>
            </>
          )}
          {run.error !== undefined && (
            <>
              <p className="mt-1 font-semibold text-err">Error</p>
              <pre className="wf-scroll max-h-48 overflow-auto rounded bg-surface p-2 whitespace-pre-wrap break-words">
                {run.error}
              </pre>
            </>
          )}
        </details>
      )}
    </li>
  );
}

export function AssistantToolRows({ runs }: { runs: AssistantToolRun[] }) {
  if (!runs.length) return null;
  return (
    <ul className="flex flex-col gap-1" aria-label="Tool calls">
      {runs.map((run) => (
        <AssistantToolRow key={run.toolCallId} run={run} />
      ))}
    </ul>
  );
}

export function AssistantMessage({ message, toolRuns = [] }: AssistantMessageProps) {
  if (message.role === 'tool') return null;
  const fromUser = message.role === 'user';
  const hasText = message.content.trim().length > 0;
  const files = message.attachments ?? [];
  if (!hasText && !files.length && !toolRuns.length) return null;
  return (
    <div
      className={cx('flex flex-col gap-1.5', fromUser ? 'items-end' : 'items-start')}
      data-message-id={message.id}
    >
      {(hasText || files.length > 0) && (
        <div
          className={cx(
            'max-w-[88%] min-w-0 rounded-xl px-3 py-2 text-sm break-words',
            fromUser ? 'bg-brand-soft text-ink' : 'border border-line bg-surface text-ink',
          )}
          data-role={message.role}
        >
          <span className="sr-only">{fromUser ? 'You: ' : 'Assistant: '}</span>
          {hasText && <Markdown source={message.content} />}
          {files.length > 0 && (
            <ul className="mt-1 flex flex-wrap gap-1" aria-label="Attached files">
              {files.map((file, index) => (
                <li
                  // a message's files never change order
                  // biome-ignore lint/suspicious/noArrayIndexKey: two files may share a name
                  key={`${file.fileName}-${index}`}
                  className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-xs text-ink-2"
                >
                  <Paperclip size={11} aria-hidden />
                  {file.fileName}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {!fromUser && toolRuns.length > 0 && (
        <div className="w-full max-w-[88%]">
          <AssistantToolRows runs={toolRuns} />
        </div>
      )}
    </div>
  );
}
