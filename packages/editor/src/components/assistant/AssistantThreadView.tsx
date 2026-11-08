/**
 * P5-67 (L2): the open thread from the store: messages, the live text, tool rows, cards (`ConfirmationCard`),
 * the task list (`TaskChecklist`, L6) and draft cards (`DraftCard`, L7).
 *
 * Tool rows come from the stored messages (a call and its saved result) and from the live events of this
 * session, which win: they know a failed call. A row whose call no shown message holds (a call sent before its
 * message reached this tab) shows after the messages.
 */
import type { AssistantMessageDTO } from '@workflow/workflow';
import { Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import type { AssistantDraftArtifact } from '../../api/types';
import { Markdown } from '../../lib/markdown';
import { type AssistantPhase, type AssistantToolRun, useAssistantStore } from '../../stores/assistant-store';
import { Callout, PageLoader, Spinner } from '../ui/misc';
import { draftCardElementId } from './ArtifactsPanel';
import { AssistantMessage, AssistantToolRows } from './AssistantMessage';
import { ConfirmationCard } from './ConfirmationCard';
import { DraftCard } from './DraftCard';
import { TaskChecklist } from './TaskChecklist';

export interface AssistantThreadViewProps {
  threadId: string;
}

/** the empty thread's prompt */
export const ASSISTANT_EMPTY_TEXT = 'Ask about your workflows, or ask me to build one';

/** the rows of each assistant message, by message id, and the live rows no message holds */
export function toolRowsOf(
  messages: AssistantMessageDTO[],
  live: AssistantToolRun[],
  phase: AssistantPhase,
): { byMessage: Map<string, AssistantToolRun[]>; loose: AssistantToolRun[] } {
  const results = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'tool' && message.toolCallId) results.set(message.toolCallId, message.content);
  }
  const liveById = new Map(live.map((run) => [run.toolCallId, run]));
  const placed = new Set<string>();
  const byMessage = new Map<string, AssistantToolRun[]>();
  const open = phase === 'running' || phase === 'suspended';
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
    const rows = message.toolCalls.map((call): AssistantToolRun => {
      placed.add(call.id);
      const run = liveById.get(call.id);
      if (run) return { ...run, args: Object.keys(run.args).length ? run.args : call.args };
      const result = results.get(call.id);
      if (result !== undefined) {
        return { toolCallId: call.id, toolName: call.name, args: call.args, state: 'done', result };
      }
      return {
        toolCallId: call.id,
        toolName: call.name,
        args: call.args,
        state: open ? 'running' : 'failed',
        error: open ? undefined : 'No result was saved',
      };
    });
    byMessage.set(message.id, rows);
  }
  return { byMessage, loose: live.filter((run) => !placed.has(run.toolCallId)) };
}

export function AssistantThreadView({ threadId }: AssistantThreadViewProps) {
  const activeThreadId = useAssistantStore((s) => s.activeThreadId);
  const messages = useAssistantStore((s) => s.messages);
  const streamingText = useAssistantStore((s) => s.streamingText);
  const toolRuns = useAssistantStore((s) => s.toolRuns);
  const pending = useAssistantStore((s) => s.pending);
  const tasks = useAssistantStore((s) => s.tasks);
  const artifacts = useAssistantStore((s) => s.artifacts);
  const status = useAssistantStore((s) => s.status);
  const error = useAssistantStore((s) => s.error);
  const scroller = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => toolRowsOf(messages, toolRuns, status), [messages, toolRuns, status]);
  const drafts = artifacts.filter(
    (artifact): artifact is AssistantDraftArtifact => artifact.type === 'draft',
  );

  // keep the newest text in view while a turn writes
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the thread grows
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamingText, toolRuns.length, pending.length, drafts.length]);

  if (activeThreadId !== threadId || status === 'loading') return <PageLoader label="Loading the chat" />;

  const visible = messages.filter((message) => message.role !== 'tool');
  const running = status === 'running';
  const toolRunning = toolRuns.some((run) => run.state === 'running');
  const empty = !visible.length && !streamingText && !running && !pending.length && !error;

  return (
    <div ref={scroller} className="wf-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">
      {empty ? (
        <div className="flex flex-col items-center gap-2 px-2 py-14 text-center">
          <Sparkles size={22} className="text-brand" aria-hidden />
          <p className="font-display text-md font-semibold">{ASSISTANT_EMPTY_TEXT}</p>
          <p className="max-w-80 text-sm text-ink-2">
            The Assistant reads your workspace and asks before it changes anything.
          </p>
        </div>
      ) : (
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          <div className="flex flex-col gap-3" role="log" aria-label="Assistant chat">
            {visible.map((message) => (
              <AssistantMessage
                key={message.id}
                message={message}
                toolRuns={rows.byMessage.get(message.id)}
              />
            ))}
            {rows.loose.length > 0 && <AssistantToolRows runs={rows.loose} />}
            {streamingText && (
              <div className="flex justify-start">
                <div
                  className="max-w-[88%] min-w-0 rounded-xl border border-line bg-surface px-3 py-2 text-sm break-words text-ink"
                  data-role="assistant"
                  data-live
                >
                  <span className="sr-only">Assistant: </span>
                  <Markdown source={streamingText} />
                </div>
              </div>
            )}
          </div>
          {running && !streamingText && !toolRunning && (
            <p className="flex items-center gap-2 text-xs text-ink-2" role="status">
              <Spinner size={13} className="text-brand" /> Thinking
            </p>
          )}
          {tasks.length > 0 && <TaskChecklist tasks={tasks} />}
          {drafts.map((draft) => (
            <div key={draft.draftId} id={draftCardElementId(draft.draftId)} tabIndex={-1}>
              <DraftCard draft={draft} />
            </div>
          ))}
          {pending.map((confirmation) => (
            <ConfirmationCard key={confirmation.requestId} confirmation={confirmation} />
          ))}
          {error && (
            <Callout tone="err" title="Couldn't complete the request">
              {error}
            </Callout>
          )}
        </div>
      )}
    </div>
  );
}
