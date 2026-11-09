/**
 * P5-62: the AI builder's side panel (`ui.sidePanel === 'builder'`): the chat (each message through
 * `Markdown`, never raw HTML), the running turn's progress rows, the questions, plan and web fetch
 * messages, the draft review bar and the prompt box (5000 characters, n8n's limit text). Opening it loads
 * this workflow's chat once (`loadHistory`); "Clear chat" goes to `clearBuilderSession`. A viewer, or a
 * read-only workflow, gets the chat without a prompt box.
 */
import { BUILDER_PROMPT_LIMIT } from '@workflow/workflow';
import { ArrowUp, CheckCircle2, Eraser, Sparkles, Square, X, XCircle } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useMe } from '../../api/queries';
import { clearBuilderSession } from '../../features/builder/session-actions';
import { useCanEditWorkflow } from '../../features/editor/open-resources';
import { type BuilderProgress, useBuilderStore } from '../../stores/builder-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { Button, IconButton } from '../ui/Button';
import { TextArea } from '../ui/Field';
import { Callout, Spinner } from '../ui/misc';
import { BuilderMessage } from './BuilderMessage';
import { DraftReviewBar } from './DraftReviewBar';
import { NotificationBanner } from './NotificationBanner';
import { PlanMessage } from './PlanMessage';
import { PlanModeToggle } from './PlanModeToggle';
import { QuestionsMessage } from './QuestionsMessage';
import { WebFetchApprovalMessage } from './WebFetchApprovalMessage';

export interface BuilderPanelProps {
  onClose: () => void;
}

/** `search_nodes` -> `Search nodes` (a row shows the tool's summary when it has one) */
function toolLabel(row: BuilderProgress): string {
  if (row.summary) return row.summary;
  const words = row.toolName.replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Working';
}

function ProgressRow({ row }: { row: BuilderProgress }) {
  return (
    <li className="flex items-center gap-2 text-xs text-ink-2">
      {row.status === 'running' && <Spinner size={13} className="text-brand" />}
      {row.status === 'done' && <CheckCircle2 size={13} className="shrink-0 text-ok" aria-label="Done" />}
      {row.status === 'error' && <XCircle size={13} className="shrink-0 text-err" aria-label="Failed" />}
      <span className="min-w-0 truncate">{toolLabel(row)}</span>
    </li>
  );
}

export function BuilderPanel({ onClose }: BuilderPanelProps) {
  const workflowId = useWorkflowStore((s) => s.meta.id);
  const hasNodes = useWorkflowStore((s) => s.nodes.length > 0);
  const readOnly = useWorkflowStore((s) => s.readOnly);
  const me = useMe().data;
  const canEdit = useCanEditWorkflow();
  const messages = useBuilderStore((s) => s.messages);
  const progress = useBuilderStore((s) => s.progress);
  const streaming = useBuilderStore((s) => s.streaming);
  const questions = useBuilderStore((s) => s.questions);
  const plan = useBuilderStore((s) => s.plan);
  const pendingWebFetch = useBuilderStore((s) => s.pendingWebFetch);
  const error = useBuilderStore((s) => s.error);
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const canWrite = Boolean(me) && canEdit;

  // this workflow's chat, once per workflow (`reset` empties the messages when another one opens)
  useEffect(() => {
    if (!workflowId) return;
    const state = useBuilderStore.getState();
    if (state.messages.length || state.streaming) return;
    void state.loadHistory(workflowId);
  }, [workflowId]);

  // keep the newest message and progress row in view
  const last = messages.at(-1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the scroll follows the chat's length and text
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length, last?.text, progress.length, questions, plan, pendingWebFetch, error]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!text.trim() || streaming) return;
    const message = text;
    setText('');
    void useBuilderStore.getState().send(message);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const atLimit = text.length >= BUILDER_PROMPT_LIMIT;
  const placeholder =
    hasNodes || messages.length ? 'What would you like to modify or add?' : 'Ask AI to build...';
  const empty = !messages.length && !progress.length && !streaming && !error;

  return (
    <aside
      className="flex h-full w-[380px] flex-col border-l border-line bg-surface shadow-lift"
      aria-label="AI builder"
    >
      <div className="flex items-start gap-2 px-4 pt-4 pb-3">
        <Sparkles size={18} className="mt-0.5 text-brand" />
        <div className="min-w-0 flex-1">
          <h2 className="text-md font-semibold">AI builder</h2>
          <p className="text-xs text-ink-2">Drafts stay unsaved until you accept them.</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<Eraser size={14} />}
          disabled={!workflowId || streaming || !messages.length}
          onClick={() => workflowId && void clearBuilderSession(workflowId)}
        >
          Clear chat
        </Button>
        <IconButton label="Close the AI builder" size="sm" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <NotificationBanner />

      <div ref={listRef} className="wf-scroll min-h-0 flex-1 overflow-y-auto border-t border-line px-4 py-3">
        {empty ? (
          <div className="flex flex-col items-center gap-2 px-2 py-10 text-center">
            <Sparkles size={22} className="text-brand" />
            <p className="font-display text-md font-semibold">What would you like to automate?</p>
            <p className="max-w-64 text-sm text-ink-2">
              Describe the workflow. The builder drafts it on the canvas, and you review every change before
              it is saved.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-3" role="log" aria-label="Builder chat">
              {messages.map((message) => (
                <BuilderMessage key={message.id} message={message} />
              ))}
            </div>
            {progress.length > 0 && (
              <ul className="flex flex-col gap-1" aria-label="Progress">
                {progress.map((row, i) => (
                  // rows have no id: they are only appended or updated in place during one turn
                  // biome-ignore lint/suspicious/noArrayIndexKey: a row's position never changes within a turn
                  <ProgressRow key={`${row.toolName}-${i}`} row={row} />
                ))}
              </ul>
            )}
            {streaming && !progress.some((p) => p.status === 'running') && (
              <p className="flex items-center gap-2 text-xs text-ink-2">
                <Spinner size={13} className="text-brand" /> Thinking
              </p>
            )}
            {questions && questions.length > 0 && <QuestionsMessage questions={questions} />}
            {plan && <PlanMessage plan={plan} />}
            {pendingWebFetch && (
              <WebFetchApprovalMessage url={pendingWebFetch.url} domain={pendingWebFetch.domain} />
            )}
            {error && (
              <Callout tone="err" title={error.title}>
                {error.message}
              </Callout>
            )}
          </div>
        )}
      </div>

      <DraftReviewBar />

      <div className="border-t border-line px-4 py-3">
        {!canWrite ? (
          <p className="text-sm text-ink-2">Only editors can build with AI.</p>
        ) : readOnly ? (
          <p className="text-sm text-ink-2">This workflow is read only.</p>
        ) : (
          <form className="flex flex-col gap-2" onSubmit={submit}>
            <TextArea
              aria-label="Message the AI builder"
              rows={3}
              maxLength={BUILDER_PROMPT_LIMIT}
              placeholder={placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
            />
            {atLimit && (
              <p className="text-xs text-warn" role="status">
                You've reached the 5000 character limit
              </p>
            )}
            <div className="flex items-center gap-2">
              <PlanModeToggle />
              <span className="flex-1" />
              {streaming ? (
                <IconButton
                  label="Stop"
                  variant="secondary"
                  onClick={() => useBuilderStore.getState().stop()}
                >
                  <Square size={14} />
                </IconButton>
              ) : (
                <IconButton label="Send" variant="secondary" type="submit" disabled={!text.trim()}>
                  <ArrowUp size={16} />
                </IconButton>
              )}
            </div>
          </form>
        )}
      </div>
    </aside>
  );
}
