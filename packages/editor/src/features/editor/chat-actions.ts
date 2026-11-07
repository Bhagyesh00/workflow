/**
 * Canvas chat (P5-59): what the chat panel does around the widget. A message first saves the workflow
 * when needed, registers a test listener for the Chat Trigger (`listenTestWebhook`, with the destination
 * node of a step run), puts the run store in the listening state, and gives the widget the path of the
 * test URL plus the test token. The POST then stays on the page's origin (the CSP allows `connect-src
 * 'self'` only); the server's `testWebhookReceived` makes the run store adopt the run. One run per message.
 */
import type { ChatRequestOverride } from '@workflow/chat-widget';
import {
  CHAT_TEST_HEADER,
  CHAT_TRIGGER_TYPE,
  type Connections,
  type Item,
  type RunData,
  type TaskData,
  type WorkflowNode,
} from '@workflow/workflow';
import { chatFetch } from '../../api/chat-transport';
import { errorMessage } from '../../api/client';
import { workflowsApi } from '../../api/endpoints';
import { type ChatLine, useChatStore } from '../../stores/chat-store';
import { useRunStore } from '../../stores/run-store';
import { toast, useUiStore } from '../../stores/ui-store';
import { getAncestors } from '../../lib/workflow-ops';
import { useWorkflowStore } from '../../stores/workflow-store';
import { type EditorDeps, ranDefinitionOf, saveWorkflow, stopListening } from './editor-actions';

/** the Chat Trigger a canvas chat talks to: the first enabled one */
export function chatTriggerOf(nodes: WorkflowNode[]): WorkflowNode | undefined {
  return nodes.find((node) => node.type === CHAT_TRIGGER_TYPE && !node.disabled);
}

/**
 * The enabled Chat Trigger above `destination` that has neither pinned data nor a result in `runData`: a
 * step run below it has no input of its own, so the chat supplies it (the run stops at `destination`).
 */
export function chatTriggerBelow(
  nodes: WorkflowNode[],
  connections: Connections,
  destination: string,
  data: { pinData: Record<string, Item[]>; runData: RunData },
): WorkflowNode | undefined {
  const upstream = new Set(getAncestors(connections, destination));
  return nodes.find(
    (node) =>
      node.type === CHAT_TRIGGER_TYPE &&
      !node.disabled &&
      upstream.has(node.name) &&
      !data.pinData[node.name] &&
      !data.runData[node.name]?.length,
  );
}

/** Open the log panel on its Chat tab; `destinationNode` makes the next messages stop at that node. */
export function openChat(destinationNode?: string | null): void {
  if (destinationNode !== undefined) useChatStore.getState().setDestination(destinationNode);
  const ui = useUiStore.getState();
  ui.setLogPanelTab('chat');
  ui.setLogPanel(true);
}

export interface ChatPanelOptions {
  enableStreaming: boolean;
  allowFileUploads: boolean;
  allowedFilesMimeTypes: string | undefined;
  /** the trigger is public: the Embed button shows */
  isPublic: boolean;
}

/** widget options that come from the trigger node's parameters */
export function chatOptionsOf(node: WorkflowNode | undefined): ChatPanelOptions {
  const parameters = node?.parameters ?? {};
  const raw = parameters.options;
  const options = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const mime = typeof options.allowedFilesMimeTypes === 'string' ? options.allowedFilesMimeTypes.trim() : '';
  return {
    enableStreaming: options.responseMode === 'streaming',
    allowFileUploads: options.allowFileUploads === true,
    allowedFilesMimeTypes: mime || undefined,
    isPublic: parameters.public === true,
  };
}

/** the text of a reply the widget hands `afterMessageSent`: a string, a JSON object, or nothing */
export function replyTextOf(response: unknown): string {
  if (typeof response === 'string') return response.trim();
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const record = response as Record<string, unknown>;
    for (const key of ['output', 'text', 'message']) {
      const value = record[key];
      if (typeof value === 'string') return value.trim();
    }
  }
  return '';
}

/** `pathname + search` of a test URL, so the POST stays on the page's origin */
export function pathOfTestUrl(testUrl: string): string {
  const base = typeof location !== 'undefined' ? location.href : 'http://localhost/';
  const url = new URL(testUrl, base);
  return `${url.pathname}${url.search}`;
}

export interface ChatSender {
  beforeMessageSent(message: string): Promise<ChatRequestOverride | undefined>;
  afterMessageSent(message: string, response?: unknown): void;
  fetch: typeof fetch;
}

/** The hooks and the fetch of one mounted widget; `getDeps` is read at each send, so the widget need not remount. */
export function createChatSender(getDeps: () => EditorDeps): ChatSender {
  /** why the last `beforeMessageSent` could not prepare the run; the next request then fails */
  let failure: string | null = null;

  const fail = (message: string, title = 'Could not send the message'): undefined => {
    failure = message;
    toast.error(title, message);
    return undefined;
  };

  return {
    async beforeMessageSent() {
      failure = null;
      const run = useRunStore.getState();
      const chat = useChatStore.getState();
      // an answer to a waiting run goes to the run's own resume URL, which the widget keeps
      if (run.status === 'waiting' && chat.hasSent) return undefined;
      if (run.status === 'starting' || run.status === 'running') {
        return fail('The previous message is still being answered.');
      }
      const trigger = chatTriggerOf(useWorkflowStore.getState().nodes);
      if (!trigger) return fail('This workflow has no enabled Chat Trigger.');

      const store = useWorkflowStore.getState();
      let id = store.meta.id;
      if (!id || store.dirty) {
        const saved = await saveWorkflow(getDeps());
        id = saved?.id;
        if (!id) return fail('Save the workflow first.');
      }
      const destinationNode = chat.destinationNode ?? undefined;
      try {
        const listened = await workflowsApi.listenTestWebhook(
          id,
          trigger.name,
          destinationNode ? { destinationNode } : {},
        );
        useRunStore
          .getState()
          .beginListening(
            id,
            { nodeName: trigger.name, testUrl: listened.testUrl, expiresAt: listened.expiresAt, chat: true },
            ranDefinitionOf(useWorkflowStore.getState()),
          );
        useChatStore.getState().markSent();
        return {
          url: pathOfTestUrl(listened.testUrl),
          ...(listened.chatTestToken ? { headers: { [CHAT_TEST_HEADER]: listened.chatTestToken } } : {}),
        };
      } catch (error) {
        return fail(errorMessage(error), 'Could not listen for a chat message');
      }
    },

    afterMessageSent(message, response) {
      const chat = useChatStore.getState();
      chat.addMessage('user', message);
      const reply = replyTextOf(response);
      if (reply) chat.addMessage('bot', reply);
    },

    async fetch(input, init) {
      if (failure) {
        const message = failure;
        failure = null;
        throw new Error(message);
      }
      try {
        const response = await chatFetch(input, init);
        // nothing started the run: do not leave the canvas waiting for a call
        if (!response.ok && useRunStore.getState().status === 'listening') await stopListening();
        return response;
      } catch (error) {
        if (useRunStore.getState().status === 'listening') await stopListening();
        throw error;
      }
    },
  };
}

function firstJson(task: TaskData | undefined): Record<string, unknown> | undefined {
  const item = task?.data?.main?.[0]?.[0];
  return item && typeof item.json === 'object' && item.json !== null
    ? (item.json as Record<string, unknown>)
    : undefined;
}

function textOfJson(json: Record<string, unknown> | undefined, keys: string[]): string {
  for (const key of keys) {
    const value = json?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * The conversation of a shown execution, for a panel that cannot send: the message the Chat Trigger
 * received, then what the Respond to Chat nodes said (else the last node's output).
 */
export function storedChatMessages(runData: RunData, nodes: WorkflowNode[]): ChatLine[] {
  const lines: ChatLine[] = [];
  const trigger = chatTriggerOf(nodes);
  if (!trigger) return lines;
  const asked = textOfJson(firstJson(runData[trigger.name]?.[0]), ['chatInput']);
  if (asked) lines.push({ id: 'stored-user', sender: 'user', text: asked });

  const replies: Array<{ at: number; text: string }> = [];
  for (const node of nodes) {
    if (node.type !== 'ai.chat') continue;
    for (const task of runData[node.name] ?? []) {
      const text = textOfJson(firstJson(task), ['message', 'output', 'text']);
      if (text) replies.push({ at: task.startTime, text });
    }
  }
  if (replies.length === 0) {
    let latest: TaskData | undefined;
    for (const [name, tasks] of Object.entries(runData)) {
      if (name === trigger.name) continue;
      for (const task of tasks) if (!latest || task.startTime >= latest.startTime) latest = task;
    }
    const text = textOfJson(firstJson(latest), ['output', 'text', 'message']);
    if (text) replies.push({ at: latest?.startTime ?? 0, text });
  }
  replies.sort((a, b) => a.at - b.at);
  for (const [index, reply] of replies.entries()) {
    lines.push({ id: `stored-bot-${index}`, sender: 'bot', text: reply.text });
  }
  return lines;
}
