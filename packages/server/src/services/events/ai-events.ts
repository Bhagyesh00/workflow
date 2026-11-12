/**
 * P6-59 (S5, L2): the 14 `ai.*` events from the run lifecycle's `aiEvent` hook, emitted on `ctx.events`. The node's
 * `msg` reaches only the tenant's own destinations, is cut at 256 KB, and is '' when the context's `redacted` is true
 * (a named deviation from n8n: a run whose redaction applies sends no run text). The payload is built only when a
 * destination takes the event.
 */
import type { ServiceDeps } from '../../context';
import type { LifecycleObserver } from '../observability/lifecycle';

/** a node's `msg` is cut at this many bytes (the destination queue is also bounded by bytes, L3) */
export const MAX_AI_MSG_BYTES = 256 * 1024;

/** cuts `text` to `MAX_AI_MSG_BYTES` bytes of UTF-8 without leaving a broken character at the end */
export function capAiMsg(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MAX_AI_MSG_BYTES) return text;
  return Buffer.from(text, 'utf8')
    .subarray(0, MAX_AI_MSG_BYTES)
    .toString('utf8')
    .replace(/\uFFFD+$/, '');
}

export function createAiEventsObserver(deps: ServiceDeps): LifecycleObserver {
  return {
    aiEvent(c) {
      let events: ReturnType<ServiceDeps['context']>['events'];
      try {
        events = deps.context().events;
      } catch {
        return;
      }
      events.emit(c.tenantId, c.name, () => ({
        msg: c.redacted ? '' : capAiMsg(c.msg),
        workflowName: c.definition.name,
        executionId: c.executionId,
        nodeName: c.nodeName,
        workflowId: c.row.workflowId,
        nodeType: c.nodeType,
      }));
    },
  };
}
