/**
 * MLflow trace export for the Databricks AI Agent. One experiment is found or created once per run and
 * each agent item becomes one trace: the trace record (`/api/3.0/mlflow/traces`), then its spans written
 * to the signed storage address the workspace hands out. Calls to the workspace carry the credential's
 * token through the guarded client; the signed upload carries only the headers the workspace sent, never
 * the token. Every payload is redacted before it leaves.
 */
import { randomBytes } from 'node:crypto';
import type { DataObject, ExecuteContext, HttpRequestOptions } from '@workflow/workflow';
import { databricksHttpsHost } from '../../../shared/databricks';
import { redactSecrets } from '../../../shared/utils';
import type { AgentItemEvent, AgentItemObserver } from '../../agent/Agent.node';

const CREDENTIAL = 'databricksOAuth2Api';
const MAX_TEXT = 100_000;

/** the experiment the traces go to: a name (found or created) or an existing id */
export interface MlflowExperiment {
  mode: 'name' | 'id';
  value: string;
}

/** the experiment locator parameter; a blank name falls back to one named after the workflow */
export function readExperiment(raw: unknown, workflowId: string | undefined): MlflowExperiment {
  const located = raw !== null && typeof raw === 'object' ? (raw as DataObject) : undefined;
  const mode = located?.mode === 'id' ? 'id' : 'name';
  const value = String(located ? (located.value ?? '') : (raw ?? '')).trim();
  if (value) return { mode, value };
  return { mode: 'name', value: `/Shared/workflow-traces-${workflowId ?? 'workflow'}` };
}

/** serialize, redact secrets in the text, parse again: the payload keeps its shape without the secrets */
function redactPayload<T>(payload: T): T {
  return JSON.parse(redactSecrets(JSON.stringify(payload))) as T;
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}...` : text;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return clip(value);
  try {
    return clip(JSON.stringify(value) ?? '');
  } catch {
    return '';
  }
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const nanos = (ms: number) => String(Math.round(ms) * 1_000_000);
const attribute = (value: unknown) => JSON.stringify(value);

interface Span {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  start_time_unix_nano: string;
  end_time_unix_nano: string;
  status: { code: 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR'; message?: string };
  attributes: Record<string, string>;
}

/** The agent run as spans: one agent span with a tool span per intermediate step, laid end to end. */
export function buildSpans(traceId: string, event: AgentItemEvent): Span[] {
  const rootId = hex(8);
  const failed = Boolean(event.error);
  const usage = event.result?.usage;
  const root: Span = {
    trace_id: traceId,
    span_id: rootId,
    name: 'Agent',
    start_time_unix_nano: nanos(event.startedAt),
    end_time_unix_nano: nanos(event.endedAt),
    status: failed
      ? { code: 'STATUS_CODE_ERROR', message: clip(event.error?.message ?? 'The agent failed') }
      : { code: 'STATUS_CODE_OK' },
    attributes: {
      'mlflow.traceRequestId': attribute(traceId),
      'mlflow.spanType': attribute('AGENT'),
      'mlflow.spanInputs': attribute({ input: clip(event.input) }),
      'mlflow.spanOutputs': attribute(failed ? {} : { output: event.result?.output }),
      ...(usage
        ? {
            'mlflow.chat.tokenUsage': attribute({
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              total_tokens: usage.inputTokens + usage.outputTokens,
            }),
          }
        : {}),
    },
  };
  const spans: Span[] = [root];
  let cursor = event.startedAt;
  for (const step of event.result?.intermediateSteps ?? []) {
    const start = Math.min(cursor, event.endedAt);
    const end = Math.max(start, Math.min(start + Math.max(0, step.durationMs), event.endedAt));
    cursor = end;
    spans.push({
      trace_id: traceId,
      span_id: hex(8),
      parent_span_id: rootId,
      name: step.action.tool,
      start_time_unix_nano: nanos(start),
      end_time_unix_nano: nanos(end),
      status: step.error
        ? { code: 'STATUS_CODE_ERROR', message: 'The tool failed' }
        : { code: 'STATUS_CODE_OK' },
      attributes: {
        'mlflow.traceRequestId': attribute(traceId),
        'mlflow.spanType': attribute('TOOL'),
        'mlflow.spanInputs': attribute(step.action.toolInput),
        'mlflow.spanOutputs': attribute(clip(step.observation)),
      },
    });
  }
  return spans;
}

/** each export call waits this long: a hanging workspace must not hold a finished agent item */
const EXPORT_TIMEOUT_MS = 10_000;

/**
 * The observer that exports one trace per finished agent item. A failed export logs a warning with no user
 * text and never fails the node.
 */
export function createMlflowObserver(
  ctx: ExecuteContext,
  hostText: string,
  experiment: MlflowExperiment,
): AgentItemObserver {
  const host = databricksHttpsHost(hostText);
  const call = async <T>(request: HttpRequestOptions): Promise<{ status: number; body: T }> => {
    const response = (await ctx.helpers.httpRequestWithAuthentication(CREDENTIAL, {
      ...request,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
      timeout: EXPORT_TIMEOUT_MS,
    })) as { body?: T; statusCode: number };
    return { status: response.statusCode, body: (response.body ?? {}) as T };
  };
  const ok = (status: number) => status >= 200 && status < 300;

  let experimentId: Promise<string> | undefined;
  const resolveExperiment = (): Promise<string> => {
    experimentId ??= (async () => {
      if (experiment.mode === 'id') return experiment.value;
      const found = await call<{ experiment?: { experiment_id?: string } }>({
        url: `${host}/api/2.0/mlflow/experiments/get-by-name`,
        qs: { experiment_name: experiment.value },
      });
      if (ok(found.status) && found.body.experiment?.experiment_id) {
        return found.body.experiment.experiment_id;
      }
      if (found.status !== 404) throw new Error(`The MLflow experiment lookup failed (${found.status})`);
      const created = await call<{ experiment_id?: string }>({
        url: `${host}/api/2.0/mlflow/experiments/create`,
        method: 'POST',
        body: { name: experiment.value },
      });
      if (!ok(created.status) || !created.body.experiment_id) {
        throw new Error(`The MLflow experiment could not be created (${created.status})`);
      }
      return created.body.experiment_id;
    })();
    return experimentId;
  };

  const exportEvent = async (event: AgentItemEvent): Promise<void> => {
    const id = await resolveExperiment();
    const failed = Boolean(event.error);
    const info = redactPayload({
      trace: {
        trace_info: {
          trace_location: { type: 'MLFLOW_EXPERIMENT', mlflow_experiment: { experiment_id: id } },
          request_time: new Date(event.startedAt).toISOString(),
          execution_duration: `${(Math.max(0, event.endedAt - event.startedAt) / 1000).toFixed(3)}s`,
          state: failed ? 'ERROR' : 'OK',
          request_preview: clip(event.input).slice(0, 1000),
          response_preview: failed ? '' : textOf(event.result?.output).slice(0, 1000),
          trace_metadata: {},
          tags: { 'mlflow.traceName': 'Databricks AI Agent' },
        },
      },
    });
    const created = await call<{
      trace?: { trace_info?: { trace_id?: string } };
      trace_info?: { trace_id?: string };
    }>({ url: `${host}/api/3.0/mlflow/traces`, method: 'POST', body: info });
    const traceId = created.body.trace?.trace_info?.trace_id ?? created.body.trace_info?.trace_id;
    if (!ok(created.status) || !traceId) {
      throw new Error(`The MLflow trace could not be created (${created.status})`);
    }
    const target = await call<{
      credential_info?: { signed_uri?: string; headers?: Array<{ name?: string; value?: string }> };
    }>({
      url: `${host}/api/2.0/mlflow/traces/${encodeURIComponent(traceId)}/credentials-for-data-upload`,
    });
    const signed = target.body.credential_info?.signed_uri;
    if (!ok(target.status) || !signed) {
      throw new Error(`The MLflow upload address could not be read (${target.status})`);
    }
    let uploadUrl: URL;
    try {
      uploadUrl = new URL(signed);
    } catch {
      throw new Error('The MLflow upload address is not a URL');
    }
    if (uploadUrl.protocol !== 'https:') throw new Error('The MLflow upload address must be https');
    // only what the workspace sent: the OAuth token never goes to the storage host
    const headers: Record<string, string> = {};
    for (const header of target.body.credential_info?.headers ?? []) {
      if (header.name && typeof header.value === 'string') headers[header.name] = header.value;
    }
    await ctx.helpers.httpRequest({
      url: uploadUrl.toString(),
      method: 'PUT',
      headers,
      body: redactPayload({ spans: buildSpans(traceId, event) }),
      followRedirects: false,
      timeout: EXPORT_TIMEOUT_MS,
    });
  };

  return async (event) => {
    try {
      await exportEvent(event);
    } catch {
      // the error text may quote the prompt or a response, so only the fact is logged
      ctx.logger.warn('The MLflow trace export failed', { itemIndex: event.itemIndex });
    }
  };
}
