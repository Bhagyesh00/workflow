/**
 * "Chat" tab of the log panel (P5-59): the chat widget (`createChat` of @workflow/chat-widget) mounted in
 * a ref, talking to the workflow's Chat Trigger through its test URL and `chatFetch`. Mounting makes no
 * request (`loadPreviousSession: false`: no test URL exists before a send). Each message saves if
 * needed, registers a test listener and posts to the path of the test URL (see chat-actions.ts). A panel
 * that cannot run (a read only role) shows the messages stored in the execution on screen.
 */
import '@workflow/chat-widget/chat.css';
import { type ChatInstance, createChat } from '@workflow/chat-widget';
import { Check, Code2, Copy, ExternalLink, MessageSquarePlus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useNodeTypes } from '../../api/queries';
import {
  chatOptionsOf,
  chatTriggerOf,
  createChatSender,
  storedChatMessages,
} from '../../features/editor/chat-actions';
import type { EditorDeps } from '../../features/editor/editor-actions';
import { shortSessionId, useChatStore } from '../../stores/chat-store';
import { useRunStore } from '../../stores/run-store';
import { toast } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { Button, IconButton } from '../ui/Button';
import { cx } from '../ui/cx';
import { EmptyState } from '../ui/misc';
import { EmbedModal } from './EmbedModal';

export function ChatPanel() {
  const nodes = useWorkflowStore((s) => s.nodes);
  const readOnly = useWorkflowStore((s) => s.readOnly);
  const trigger = useMemo(() => chatTriggerOf(nodes), [nodes]);

  if (!trigger) {
    return (
      <EmptyState
        title="No chat trigger"
        description="Add and enable a Chat Trigger to chat with this workflow."
        className="py-8"
      />
    );
  }
  return readOnly ? <StoredChat /> : <LiveChat triggerName={trigger.name} />;
}

/** A role that cannot run: the conversation of the execution on screen, as text. */
function StoredChat() {
  const nodes = useWorkflowStore((s) => s.nodes);
  const runData = useRunStore((s) => s.runData);
  const lines = useMemo(() => storedChatMessages(runData, nodes), [runData, nodes]);
  if (lines.length === 0) {
    return (
      <EmptyState
        title="Chat is read only"
        description="Your role cannot send messages. Open an execution to read its conversation."
        className="py-8"
      />
    );
  }
  return (
    <ol className="flex flex-col gap-2 px-4 py-3" aria-label="Stored chat messages">
      {lines.map((line) => (
        <li
          key={line.id}
          className={cx(
            'max-w-[80%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap',
            line.sender === 'user' ? 'self-end bg-brand-soft text-ink' : 'self-start bg-surface-3 text-ink',
          )}
        >
          {line.text}
        </li>
      ))}
    </ol>
  );
}

function LiveChat({ triggerName }: { triggerName: string }) {
  const navigate = useNavigate();
  const nodeTypes = useNodeTypes();
  const nodes = useWorkflowStore((s) => s.nodes);
  const workflowId = useWorkflowStore((s) => s.meta.id);
  const trigger = nodes.find((n) => n.name === triggerName);
  const options = useMemo(() => chatOptionsOf(trigger), [trigger]);
  const sessionId = useChatStore((s) => s.sessionId);
  const destinationNode = useChatStore((s) => s.destinationNode);
  const executionId = useRunStore((s) => s.executionId);
  const runWorkflowId = useRunStore((s) => s.workflowId);
  const [embedOpen, setEmbedOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const target = useRef<HTMLDivElement>(null);
  const instance = useRef<ChatInstance | null>(null);

  // the sender is made once: the widget mounts again when it changes, which would drop a reply on its way
  const depsRef = useRef<EditorDeps>({ navigate, descriptions: nodeTypes });
  depsRef.current = { navigate: (to, opts) => navigate(to, opts), descriptions: nodeTypes };
  const sender = useMemo(() => createChatSender(() => depsRef.current), []);

  // the widget keeps its own DOM: it is mounted again only when an option it reads changes
  useEffect(() => {
    const element = target.current;
    if (!element) return;
    const chat = useChatStore.getState();
    const instanceNow = createChat({
      webhookUrl: window.location.origin,
      target: element,
      mode: 'fullscreen',
      sessionId: chat.sessionId,
      messageHistory: chat.messages.map((line) => ({ id: line.id, sender: line.sender, text: line.text })),
      loadPreviousSession: false,
      enableMessageActions: true,
      enableStreaming: options.enableStreaming,
      allowFileUploads: options.allowFileUploads,
      allowedFilesMimeTypes: options.allowedFilesMimeTypes,
      i18n: { en: { title: 'Chat', subtitle: '' } },
      fetch: sender.fetch,
      beforeMessageSent: sender.beforeMessageSent,
      afterMessageSent: sender.afterMessageSent,
    });
    instance.current = instanceNow;
    return () => {
      instanceNow.unmount();
      if (instance.current === instanceNow) instance.current = null;
    };
  }, [options.enableStreaming, options.allowFileUploads, options.allowedFilesMimeTypes, sender]);

  function startNewSession() {
    const id = useChatStore.getState().newSession();
    useRunStore.getState().reset();
    instance.current?.newSession(id);
  }

  async function copySession() {
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy the session id');
    }
  }

  const executionLink =
    executionId && runWorkflowId === workflowId ? `/executions/${encodeURIComponent(executionId)}` : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-1.5 text-xs text-ink-2">
        <span>Session</span>
        <code className="rounded bg-surface-3 px-1.5 py-0.5" title="The session id of this chat">
          {shortSessionId(sessionId)}
        </code>
        <IconButton label="Copy session id" size="sm" onClick={() => void copySession()}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </IconButton>
        {destinationNode && (
          <span className="flex items-center gap-1 rounded bg-surface-3 px-1.5 py-0.5">
            Runs up to {destinationNode}
            <IconButton
              label="Run the whole workflow"
              size="sm"
              onClick={() => useChatStore.getState().setDestination(null)}
            >
              <X size={12} />
            </IconButton>
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {executionLink && (
            <Link
              to={executionLink}
              className="flex items-center gap-1 font-semibold text-brand hover:underline"
            >
              <ExternalLink size={13} /> View execution
            </Link>
          )}
          {options.isPublic && (
            <Button
              size="sm"
              icon={<Code2 size={13} />}
              disabled={!workflowId}
              title={workflowId ? undefined : 'Save the workflow to get its chat URL'}
              onClick={() => setEmbedOpen(true)}
            >
              Embed chat
            </Button>
          )}
          <Button size="sm" icon={<MessageSquarePlus size={13} />} onClick={startNewSession}>
            New session
          </Button>
        </span>
      </div>
      <div ref={target} className="min-h-0 flex-1 overflow-hidden" data-testid="chat-widget-host" />
      {options.isPublic && (
        <EmbedModal
          open={embedOpen}
          onClose={() => setEmbedOpen(false)}
          workflowId={workflowId ?? undefined}
          nodeName={triggerName}
        />
      )}
    </div>
  );
}
