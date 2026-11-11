/**
 * Running a workflow for an Assistant tool (FULL from C0, C0-final; shared by L4 `run_workflow`, L6
 * `execute_node` and L7 `verify_workflow`).
 *
 * `runAndCollect` always starts the run in mode `manual`: `startErrorWorkflow` skips only `manual` and
 * `error` runs (services/executions.ts), so any other mode would start a draft's `settings.errorWorkflow`
 * for real. Its input type leaves out `mode`, `wait`, `tenantId` and `userId`, so no caller can set them.
 * `previewOutput` is what the model may read of a run: per node the last run, a few items, binary as
 * name, type and size only, every string through `redactSecrets`, the whole inside
 * `wrapUntrusted('execution-output', ...)`; with `sendValues` false, item counts and no items.
 * `triggerPinData` builds a trigger's items as that trigger would emit them, from data the model gave
 * (never evaluated).
 */
import { randomUUID } from 'node:crypto';
import {
  type DataObject,
  type ExecutionState,
  type ExecutionStatus,
  type Item,
  type RedactionChannels,
  type RunData,
  redactSecrets,
  reportedChannels,
  type WorkflowDefinition,
} from '@workflow/workflow';
import type { ServerContext } from '../../context';
import { wrapUntrusted } from '../ai-builder/context';
import type { ExecutionOutcome, StartExecutionInput, StoredRunOptions } from '../executions';
import { REDACTED_ERROR_MESSAGE } from '../redaction/policy';
import type { AssistantRunScope } from './types';

/** what a tool may pass: everything but the mode (always `manual`), `wait`, the tenant and the user */
export type RunAndCollectInput = Omit<
  StartExecutionInput,
  'tenantId' | 'mode' | 'wait' | 'userId' | 'projectId'
> & {
  /** P6 S1: the run's project (a saved workflow's row wins at run time); required so no caller misses it */
  projectId: string;
};

/** the part of a run scope `runAndCollect` needs */
export type RunAndCollectScope = Pick<AssistantRunScope, 'tenant' | 'user' | 'signal'>;

export interface RunOutcome {
  executionId: string;
  /**
   * The execution's status when it ended or parked (`waiting` is reported as such); `timedOut` when
   * it passed `timeoutMs` or the turn's signal fired, and the run was stopped.
   */
  status: ExecutionStatus | 'timedOut';
  /** the turn's signal stopped it (status `timedOut`) */
  aborted: boolean;
  error?: { message: string; node?: string };
  lastNodeExecuted?: string;
  /** every node's runs; only the last node's output when the workflow does not save manual runs */
  runData: RunData;
  /**
   * P6 S3 (C0): `ExecutionOutcome.redaction`, or for a run that did not report one (stopped, timed out) the
   * stored snapshot and the sub-workflow reports in its run data. Present only when a channel is on.
   */
  redaction?: ExecutionOutcome['redaction'];
}

/** how much of a run the model sees */
export const RUN_PREVIEW = {
  /** items per node output */
  items: 3,
  /** characters per string value */
  valueChars: 500,
  /** elements per array value */
  arrayItems: 20,
  /** keys per object value */
  keys: 50,
  /** nesting depth of a value */
  depth: 6,
} as const;

const PREVIEW_SOURCE = 'execution-output';

/**
 * Starts `input.workflow` in mode `manual` for the run's tenant and user, waits up to `timeoutMs`, and
 * reads the run data. On timeout or when `run.signal` fires the execution is stopped and the outcome is
 * `timedOut`. A run that parks (a Wait node) ends as `waiting`.
 */
export async function runAndCollect(
  ctx: ServerContext,
  run: RunAndCollectScope,
  input: RunAndCollectInput,
  timeoutMs: number,
): Promise<RunOutcome> {
  run.signal.throwIfAborted();
  const tenantId = run.tenant.id;
  // spread first, so a caller that slipped a mode past the type still runs manual
  const started = await ctx.executions.start({
    ...input,
    tenantId,
    userId: run.user.id,
    mode: 'manual',
    wait: true,
  });
  const { executionId } = started;
  const finished = started.finished ?? ctx.executions.waitFor(executionId);

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const ending = await new Promise<'finished' | 'timeout' | 'aborted'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs));
    timer.unref?.();
    onAbort = () => resolve('aborted');
    if (run.signal.aborted) resolve('aborted');
    else run.signal.addEventListener('abort', onAbort, { once: true });
    finished.then(
      () => resolve('finished'),
      () => resolve('finished'),
    );
  });
  clearTimeout(timer);
  if (onAbort) run.signal.removeEventListener('abort', onAbort);

  let outcome: ExecutionOutcome | undefined;
  if (ending === 'finished') {
    outcome = await finished.catch(() => undefined);
  } else {
    await ctx.executions.stop(tenantId, executionId).catch((error) => {
      ctx.logger.warn({ err: error, tenantId, executionId }, 'Assistant run could not be stopped');
    });
  }

  const row = await ctx.repos.executions.get(tenantId, executionId);
  const data = row ? await ctx.repos.executions.getData(tenantId, executionId) : undefined;
  const state = (data?.state ?? null) as ExecutionState | null;
  const runData = state?.resultData?.runData ?? lastNodeRunData(outcome);
  const lastNodeExecuted = state?.resultData?.lastNodeExecuted ?? outcome?.lastNodeExecuted;

  const status: RunOutcome['status'] =
    ending === 'finished'
      ? ((row?.status as ExecutionStatus | undefined) ?? outcome?.status ?? 'error')
      : 'timedOut';
  const error = row?.errorMessage
    ? { message: row.errorMessage, ...(row.errorNode ? { node: row.errorNode } : {}) }
    : outcome?.error
      ? {
          message: outcome.error.message,
          ...(typeof outcome.error.node === 'string' ? { node: outcome.error.node } : {}),
        }
      : undefined;
  const redaction = runRedaction(outcome, data?.runOptions as StoredRunOptions | null | undefined, runData);
  return {
    executionId,
    status,
    aborted: ending === 'aborted',
    ...(error ? { error } : {}),
    ...(lastNodeExecuted ? { lastNodeExecuted } : {}),
    runData,
    ...(redaction ? { redaction } : {}),
  };
}

/** P6 S3 (C0): the run's redaction channels (see `RunOutcome.redaction`); undefined when none is on */
function runRedaction(
  outcome: ExecutionOutcome | undefined,
  stored: StoredRunOptions | null | undefined,
  runData: RunData,
): RunOutcome['redaction'] {
  const redaction = outcome?.redaction ?? {
    own: { production: stored?.redaction?.production === true, manual: stored?.redaction?.manual === true },
    fromSubWorkflows: reportedChannels(runData),
  };
  const on = (c: RedactionChannels) => c.production || c.manual;
  return on(redaction.own) || on(redaction.fromSubWorkflows) ? redaction : undefined;
}

/** a run whose row was not kept (`saveManualExecutions: false`): the last node's output only */
function lastNodeRunData(outcome: ExecutionOutcome | undefined): RunData {
  if (!outcome?.lastNodeExecuted || !outcome.lastNodeOutput) return {};
  return {
    [outcome.lastNodeExecuted]: [
      {
        startTime: 0,
        executionTime: 0,
        executionStatus: outcome.status,
        data: { main: outcome.lastNodeOutput },
        source: [],
      },
    ],
  };
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** redacted before it is cut, so a cut never leaves part of a secret unmatched */
function previewString(text: string): string {
  return cut(redactSecrets(text.slice(0, RUN_PREVIEW.valueChars * 4)), RUN_PREVIEW.valueChars);
}

function previewValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return previewString(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return value === undefined ? null : previewString(String(value));
  if (depth >= RUN_PREVIEW.depth) return '[…]';
  if (Array.isArray(value)) {
    const shown = value.slice(0, RUN_PREVIEW.arrayItems).map((v) => previewValue(v, depth + 1));
    if (value.length > RUN_PREVIEW.arrayItems) shown.push(`[${value.length - RUN_PREVIEW.arrayItems} more]`);
    return shown;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, v] of entries.slice(0, RUN_PREVIEW.keys))
    out[previewString(key)] = previewValue(v, depth + 1);
  if (entries.length > RUN_PREVIEW.keys) out['[more keys]'] = entries.length - RUN_PREVIEW.keys;
  return out;
}

function previewItem(item: Item): DataObject {
  const out: DataObject = { json: previewValue(item.json ?? {}, 0) as DataObject };
  if (item.binary && typeof item.binary === 'object') {
    const files: DataObject = {};
    for (const [key, file] of Object.entries(item.binary)) {
      files[previewString(key)] = {
        fileName: typeof file?.fileName === 'string' ? previewString(file.fileName) : null,
        mimeType: typeof file?.mimeType === 'string' ? previewString(file.mimeType) : null,
        fileSize: typeof file?.fileSize === 'number' ? file.fileSize : null,
      };
    }
    out.binary = files;
  }
  if (item.error?.message) out.error = previewString(String(item.error.message));
  return out;
}

/**
 * What the model may read of a run, as one wrapped text: status, error, and per node its last run's
 * status, item counts and (with `sendValues`) the first items. Binary data never: name, type and size.
 * P6-53: a redacted run shows no error text either, only the node it failed in.
 */
export function previewOutput(outcome: RunOutcome, sendValues: boolean): string {
  // P6 S3 (C0): a run whose manual channel is redacted (its own snapshot or a sub-workflow's report) shows
  // the model no item values, as with `sendValues` off (L8 fills the snapshot)
  const redacted = isManualRedacted(outcome.redaction);
  const showValues = sendValues && !redacted;
  const nodes = Object.entries(outcome.runData ?? {}).map(([name, runs]) => {
    const last = Array.isArray(runs) ? runs[runs.length - 1] : undefined;
    const outputs = (last?.data?.main ?? []).map((items) => {
      const list = Array.isArray(items) ? items : [];
      return {
        itemCount: list.length,
        ...(showValues ? { items: list.slice(0, RUN_PREVIEW.items).map(previewItem) } : {}),
      };
    });
    return {
      node: previewString(name),
      status: last?.executionStatus ?? null,
      runs: Array.isArray(runs) ? runs.length : 0,
      outputs,
      ...(last?.error?.message && !redacted ? { error: previewString(String(last.error.message)) } : {}),
    };
  });
  const body = {
    executionId: outcome.executionId,
    status: outcome.status,
    ...(outcome.error
      ? {
          error: {
            message: redacted ? REDACTED_ERROR_MESSAGE : previewString(outcome.error.message),
            ...(outcome.error.node ? { node: previewString(outcome.error.node) } : {}),
          },
        }
      : {}),
    ...(redacted
      ? { note: 'Item values are redacted for this execution' }
      : showValues
        ? {}
        : { note: 'Item values are hidden by a workspace setting' }),
    nodes,
  };
  return wrapUntrusted(PREVIEW_SOURCE, JSON.stringify(body));
}

/** P6 S3 (C0): the manual channel is on in the run's own snapshot or in what its sub-workflows reported */
function isManualRedacted(redaction: RunOutcome['redaction']): boolean {
  return redaction?.own.manual === true || redaction?.fromSubWorkflows.manual === true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asJson(value: unknown): DataObject {
  if (isPlainObject(value)) return value as DataObject;
  if (value === undefined || value === null) return {};
  return { value: value as DataObject[string] };
}

/** one item per object of an array, one for an object, an empty one for nothing */
function plainItems(inputData: unknown): Item[] {
  if (Array.isArray(inputData))
    return inputData.length ? inputData.map((v) => ({ json: asJson(v) })) : [{ json: {} }];
  return [{ json: asJson(inputData) }];
}

const WEBHOOK_ENVELOPE_KEYS = new Set(['headers', 'params', 'query', 'body', 'webhookUrl', 'executionMode']);

/** a Webhook item: the given envelope (headers, params, query, body), or the data as the body */
function webhookItem(inputData: unknown): Item {
  const keys = isPlainObject(inputData) ? Object.keys(inputData) : [];
  const envelope =
    isPlainObject(inputData) &&
    keys.length > 0 &&
    keys.every((k) => WEBHOOK_ENVELOPE_KEYS.has(k)) &&
    keys.some((k) => k === 'headers' || k === 'query' || k === 'body' || k === 'params');
  const source = envelope ? (inputData as Record<string, unknown>) : { body: inputData ?? {} };
  return {
    json: {
      headers: isPlainObject(source.headers) ? (source.headers as DataObject) : {},
      params: isPlainObject(source.params) ? (source.params as DataObject) : {},
      query: isPlainObject(source.query) ? (source.query as DataObject) : {},
      body: (source.body ?? {}) as DataObject[string],
      executionMode: 'test',
    },
  };
}

/**
 * A Chat Trigger item: `{ sessionId, action: 'sendMessage', chatInput }` from a text or `{ chatInput }`;
 * other data becomes the message as JSON (as n8n), so the run never sends an empty message by mistake.
 */
function chatItem(inputData: unknown): Item {
  const data = isPlainObject(inputData) ? inputData : {};
  let chatInput = '';
  if (typeof inputData === 'string') chatInput = inputData;
  else if (typeof data.chatInput === 'string') chatInput = data.chatInput;
  else if (inputData !== undefined && inputData !== null) chatInput = JSON.stringify(inputData) ?? '';
  const sessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : randomUUID();
  return { json: { sessionId, action: 'sendMessage', chatInput } };
}

/** the error for Form Trigger data wrapped in `formFields` (n8n refuses it too) */
export const FORM_FIELDS_WRAPPED =
  'Couldn\'t use inputData for the Form Trigger: give the fields as a flat map, such as { "email": "ada@example.com" }, not inside formFields';

/**
 * A Form Trigger item: the fields as a flat map, plus `submittedAt` and `formMode: 'test'`. Fields wrapped
 * in a `formFields` object are refused, since the workflow would read `$json.formFields.x` that never exists.
 */
function formItems(inputData: unknown): Item[] {
  const submittedAt = new Date().toISOString();
  return plainItems(inputData).map((item) => {
    if (isPlainObject(item.json.formFields)) throw new Error(FORM_FIELDS_WRAPPED);
    return { json: { ...item.json, submittedAt, formMode: 'test' } };
  });
}

function zonedParts(date: Date, timeZone: string): Record<string, string> {
  const numeric = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const names = new Intl.DateTimeFormat('en-US', { timeZone, month: 'long', weekday: 'long' }).formatToParts(
    date,
  );
  const parts: Record<string, string> = {};
  for (const p of numeric) parts[p.type] = p.value;
  for (const p of names) if (p.type === 'month' || p.type === 'weekday') parts[`${p.type}Name`] = p.value;
  return parts;
}

/** a Schedule Trigger item: the time fields the node emits, in the workflow's timezone (UTC if unknown) */
function scheduleItem(timezone: string | undefined, inputData: unknown): Item {
  const now = new Date();
  let zone = timezone || 'UTC';
  let parts: Record<string, string>;
  try {
    parts = zonedParts(now, zone);
  } catch {
    zone = 'UTC';
    parts = zonedParts(now, zone);
  }
  const offset = (parts.timeZoneName ?? 'GMT').replace(/^GMT/, '') || '+00:00';
  const hour = Number(parts.hour) % 24;
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const ms = String(now.getUTCMilliseconds()).padStart(3, '0');
  const fields: DataObject = {
    timestamp: `${parts.year}-${parts.month}-${parts.day}T${String(hour).padStart(2, '0')}:${parts.minute}:${parts.second}.${ms}${offset}`,
    'Readable date': `${parts.monthName} ${Number(parts.day)} ${parts.year}, ${hour12}:${parts.minute}:${parts.second} ${hour < 12 ? 'AM' : 'PM'}`,
    'Day of week': parts.weekdayName ?? '',
    Year: Number(parts.year),
    Month: parts.monthName ?? '',
    'Day of month': parts.day,
    Hour: String(hour).padStart(2, '0'),
    Minute: parts.minute,
    Second: parts.second,
    Timezone: `${zone} (UTC${offset})`,
  };
  return { json: isPlainObject(inputData) ? { ...fields, ...(inputData as DataObject) } : fields };
}

/** the trigger types with their own item shape (n8n's table); any other node gets `{ json }` items */
export const TRIGGER_PIN_KINDS: Readonly<Record<string, 'form' | 'webhook' | 'chat' | 'schedule'>> = {
  'core.formTrigger': 'form',
  'core.webhook': 'webhook',
  'ai.chatTrigger': 'chat',
  'core.scheduleTrigger': 'schedule',
};

/**
 * Pin data for `triggerNode` of `definition` from the model's `inputData` (data only, never evaluated):
 * Form a flat map of fields, Webhook the envelope or the data as its body, Chat `chatInput`, Schedule the
 * time fields, any other node `{ json }` items. Throws when the node is not in the definition.
 */
export function triggerPinData(
  definition: WorkflowDefinition,
  triggerNode: string,
  inputData?: unknown,
): Record<string, Item[]> {
  const node = (definition.nodes ?? []).find((n) => n.name === triggerNode);
  if (!node) throw new Error(`Node '${triggerNode}' was not found in the workflow`);
  let items: Item[];
  switch (TRIGGER_PIN_KINDS[node.type]) {
    case 'form':
      items = formItems(inputData);
      break;
    case 'webhook':
      items = [webhookItem(inputData)];
      break;
    case 'chat':
      items = [chatItem(inputData)];
      break;
    case 'schedule':
      items = [scheduleItem(definition.settings?.timezone, inputData)];
      break;
    default:
      items = plainItems(inputData);
  }
  return { [node.name]: items };
}
