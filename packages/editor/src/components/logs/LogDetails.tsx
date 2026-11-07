/**
 * Details of the selected node run (P5-60): its input and output through the same JSON view the node
 * panel uses, the error when it failed, and for a model run the messages, tool calls and stop
 * reason. All values are written as text, never as markup.
 */
import type { Item, RunData } from '@workflow/workflow';
import { useMemo, useState } from 'react';
import { formatDuration } from '../../lib/format';
import { formatTokens, type LogNode } from '../../lib/logs-tree';
import { ErrorPanel } from '../ndv/DataPanes';
import { RunDataView } from '../ndv/RunDataView';
import { statusLabel } from '../ui/misc';
import { Tabs } from '../ui/Tabs';
import { StatusIcon } from './LogsTree';

type DetailTab = 'overview' | 'input' | 'output';

interface ToolCallView {
  id: string;
  name: string;
  args: string;
}

interface MessageView {
  id: string;
  role: string;
  content: string;
  toolCalls: ToolCallView[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toolCallsOf(value: unknown): ToolCallView[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCallView[] = [];
  for (const entry of value) {
    const call = record(entry);
    if (!call || typeof call.name !== 'string') continue;
    let args = '';
    try {
      args = JSON.stringify(call.arguments ?? {});
    } catch {
      args = '';
    }
    calls.push({ id: `call-${calls.length}`, name: call.name, args });
  }
  return calls;
}

function messageOf(value: unknown, id: string): MessageView | undefined {
  const message = record(value);
  if (!message) return undefined;
  return {
    id,
    role: typeof message.role === 'string' ? message.role : 'message',
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: toolCallsOf(message.toolCalls),
  };
}

function firstItems(connections: Record<string, Array<Item[] | null> | undefined> | undefined): Item[] {
  for (const outputs of Object.values(connections ?? {})) {
    const items = outputs?.find((list) => list && list.length > 0);
    if (items) return items;
  }
  return [];
}

/** the items a run read: recorded for sub-nodes, else the output of the run it came from */
export function inputItems(node: LogNode, runData: RunData): Item[] {
  const recorded = firstItems(node.task.inputOverride);
  if (recorded.length) return recorded;
  const source = node.task.source?.[0];
  if (!source) return [];
  const runs = runData[source.previousNode] ?? [];
  const task = runs[source.previousNodeRun ?? runs.length - 1];
  return task?.data?.main?.[source.previousNodeOutput ?? 0] ?? [];
}

export function outputItems(node: LogNode): Item[] {
  const items: Item[] = [];
  for (const outputs of Object.values(node.task.data ?? {})) {
    for (const list of outputs ?? []) if (list) items.push(...list);
  }
  return items;
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mb-3">
      <h4 className="mb-1 text-2xs font-semibold tracking-wide text-ink-3 uppercase">{label}</h4>
      {children}
    </section>
  );
}

function MessageRow({ message }: { message: MessageView }) {
  return (
    <li className="rounded-lg border border-line bg-surface-2 px-2.5 py-1.5">
      <span className="text-2xs font-semibold text-ink-3 uppercase">{message.role}</span>
      {message.content && (
        <p className="max-h-32 overflow-auto text-xs break-words whitespace-pre-wrap text-ink">
          {message.content}
        </p>
      )}
      {message.toolCalls.map((call) => (
        <p key={call.id} className="font-mono text-xs break-words text-ink-2">
          {call.name}({call.args})
        </p>
      ))}
    </li>
  );
}

function ModelOverview({ node }: { node: LogNode }) {
  const input = record(node.task.inputOverride?.ai_languageModel?.[0]?.[0]?.json);
  const output = record(node.task.data?.ai_languageModel?.[0]?.[0]?.json);
  const messages = Array.isArray(input?.messages)
    ? input.messages
        .map((m, n) => messageOf(m, `message-${n}`))
        .filter((m): m is MessageView => m !== undefined)
    : [];
  const response = messageOf(output?.response, 'response');
  const stopReason = typeof output?.stopReason === 'string' ? output.stopReason : undefined;
  const model =
    typeof output?.model === 'string'
      ? output.model
      : typeof input?.model === 'string'
        ? input.model
        : undefined;
  const availableTools = Array.isArray(input?.tools)
    ? input.tools.filter((t): t is string => typeof t === 'string')
    : [];
  if (!messages.length && !response && !stopReason) {
    return <p className="text-xs text-ink-3">This run recorded no messages.</p>;
  }
  return (
    <>
      {messages.length > 0 && (
        <Block label="Messages">
          <ol className="flex flex-col gap-1.5" aria-label="Messages">
            {messages.map((message) => (
              <MessageRow key={message.id} message={message} />
            ))}
          </ol>
        </Block>
      )}
      {response && (
        <Block label="Response">
          <ol className="flex flex-col gap-1.5" aria-label="Response">
            <MessageRow message={response} />
          </ol>
        </Block>
      )}
      {response && response.toolCalls.length > 0 && (
        <Block label="Tool calls">
          <ul className="flex flex-col gap-1" aria-label="Tool calls">
            {response.toolCalls.map((call) => (
              <li key={call.id} className="font-mono text-xs break-words text-ink">
                {call.name}
                <span className="text-ink-3">({call.args})</span>
              </li>
            ))}
          </ul>
        </Block>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {stopReason && (
          <>
            <dt className="text-ink-3">Stop reason</dt>
            <dd className="text-ink">{stopReason}</dd>
          </>
        )}
        {model && (
          <>
            <dt className="text-ink-3">Model</dt>
            <dd className="text-ink">{model}</dd>
          </>
        )}
        {availableTools.length > 0 && (
          <>
            <dt className="text-ink-3">Tools offered</dt>
            <dd className="text-ink">{availableTools.join(', ')}</dd>
          </>
        )}
      </dl>
    </>
  );
}

export function LogDetails({ node, runData }: { node: LogNode; runData: RunData }) {
  const isModel = node.type === 'ai_languageModel';
  const [tab, setTab] = useState<DetailTab>(isModel ? 'overview' : 'output');
  const input = useMemo(() => inputItems(node, runData), [node, runData]);
  const output = useMemo(() => outputItems(node), [node]);
  const items = tab === 'input' ? input : output;
  const tokens = formatTokens(node.tokens);
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={`Details of ${node.node}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-2 text-xs">
        <StatusIcon status={node.status} />
        <span className="font-semibold text-ink">{node.node}</span>
        <span className="text-ink-3">{statusLabel(node.status)}</span>
        {node.duration > 0 && <span className="text-ink-3">{formatDuration(node.duration)}</span>}
        {tokens && <span className="text-ink-3">{tokens}</span>}
      </div>
      <Tabs<DetailTab>
        size="sm"
        label="Run details"
        className="px-3 pt-1"
        value={tab}
        onChange={setTab}
        items={[
          ...(isModel ? [{ value: 'overview' as const, label: 'Overview' }] : []),
          { value: 'input', label: 'Input' },
          { value: 'output', label: 'Output' },
        ]}
      />
      <div className="wf-scroll min-h-0 flex-1 overflow-auto border-t border-line">
        {tab === 'overview' ? (
          <div className="p-3">
            <ModelOverview node={node} />
          </div>
        ) : (
          <>
            {tab === 'output' && node.task.error && <ErrorPanel error={node.task.error} />}
            <div className="h-full min-h-24">
              <RunDataView
                items={items}
                mode="json"
                empty={<p className="p-3 text-xs text-ink-3">No {tab} data for this run.</p>}
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
