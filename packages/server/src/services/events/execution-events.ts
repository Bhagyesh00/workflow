/**
 * P6-58 (S5, L1): the `workflow.*`, `node.*` and run-level `audit.workflow.*` events (n8n's names less `n8n.`) from
 * the run lifecycle, emitted on `ctx.events`. The payloads are built lazily (only when a destination takes the
 * event). Run text stays out when the context's `redacted` is true: a redacted run's `workflow.failed` carries no
 * `errorMessage`. Error text passes `redactSecrets` and is cut to 1000 characters; no stack, no node data.
 */
import { type DataObject, redactSecrets } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type {
  CancelContext,
  CrashContext,
  ExecutionScope,
  LifecycleObserver,
  RunScope,
} from '../observability/lifecycle';
import type { EventStream } from './stream';
import { userFieldsFor } from './user-fields';

const MAX_ERROR_TEXT = 1000;

/** the stream of the live context; undefined before the context is ready */
function streamOf(deps: ServiceDeps): EventStream | undefined {
  try {
    return deps.context().events;
  } catch {
    return undefined;
  }
}

/** n8n's run identity: execution, user, workflow, mode and the project (team projects carry a name) */
async function runIdentity(
  deps: ServiceDeps,
  scope: ExecutionScope,
  extra: { workflowName?: string; projectId?: string; userId?: string },
): Promise<DataObject> {
  const { tenantId, row } = scope;
  let workflowName = extra.workflowName;
  let projectId = extra.projectId;
  if (row.workflowId) {
    const workflow = await deps.repos.workflows.get(tenantId, row.workflowId);
    if (workflow) {
      workflowName = workflowName ?? workflow.name;
      // the row's project wins over a stored one (a move while the run waited)
      projectId = workflow.projectId;
    }
  }
  let projectName: string | undefined;
  if (projectId) {
    const project = await deps.repos.projects.get(tenantId, projectId);
    if (project?.type === 'team') projectName = project.name;
  }
  return {
    executionId: scope.executionId,
    ...(extra.userId ? { userId: extra.userId } : {}),
    workflowId: row.workflowId,
    isManual: row.mode === 'manual',
    mode: row.mode,
    workflowName: workflowName ?? null,
    projectId: projectId ?? null,
    ...(projectName !== undefined ? { projectName } : {}),
  };
}

const userOf = (c: RunScope): string | undefined => c.options.userId ?? c.options.endUserId;

/** the failure text of a run that is not redacted: no secret, 1000 characters at most */
function errorText(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const text = redactSecrets(message);
  return text.length > MAX_ERROR_TEXT ? text.slice(0, MAX_ERROR_TEXT) : text;
}

export function createExecutionEventsObserver(deps: ServiceDeps): LifecycleObserver {
  const nodeTypeOf = (scope: RunScope, name: string | undefined) =>
    name ? scope.definition.nodes.find((node) => node.name === name)?.type : undefined;

  return {
    runStart(c) {
      const events = streamOf(deps);
      if (!events) return;
      const identity = () =>
        runIdentity(deps, c, {
          workflowName: c.definition.name,
          projectId: c.options.projectId,
          userId: userOf(c),
        });
      if (c.kind === 'resume') {
        events.emit(c.tenantId, 'audit.workflow.resumed', async () => {
          const user = await userFieldsFor(deps, c.tenantId, userOf(c));
          return { ...(await identity()), ...user };
        });
        return;
      }
      events.emit(c.tenantId, 'workflow.started', identity);
      // n8n's two forms: with the person who ran it, or without
      events.emit(c.tenantId, 'audit.workflow.executed', async () => {
        const user = await userFieldsFor(deps, c.tenantId, userOf(c));
        return { ...(await identity()), ...user };
      });
    },

    nodeStart(c) {
      streamOf(deps)?.emit(c.tenantId, 'node.started', () => nodePayload(c, c.nodeName, c.nodeType));
    },

    nodeEnd(c) {
      streamOf(deps)?.emit(c.tenantId, 'node.finished', () => nodePayload(c, c.nodeName, c.nodeType));
    },

    runEnd(c) {
      const events = streamOf(deps);
      if (!events) return;
      const identity = () =>
        runIdentity(deps, c, {
          workflowName: c.definition.name,
          projectId: c.options.projectId,
          userId: userOf(c),
        });
      const lastNodeExecuted = c.state?.resultData.lastNodeExecuted;
      switch (c.status) {
        case 'success':
          events.emit(c.tenantId, 'workflow.success', async () => ({
            ...(await identity()),
            success: true,
            ...(lastNodeExecuted ? { lastNodeExecuted } : {}),
          }));
          return;
        case 'error':
        case 'crashed': {
          // a redacted run sends no run text: no error message
          const message = c.redacted ? undefined : errorText(c.error?.message);
          const errorNode = c.error?.node ?? lastNodeExecuted;
          events.emit(c.tenantId, 'workflow.failed', async () => ({
            ...(await identity()),
            success: false,
            ...(lastNodeExecuted ? { lastNodeExecuted } : {}),
            ...(nodeTypeOf(c, errorNode) ? { errorNodeType: nodeTypeOf(c, errorNode) } : {}),
            ...(message ? { errorMessage: message } : {}),
          }));
          return;
        }
        case 'waiting':
          events.emit(c.tenantId, 'audit.workflow.waiting', async () => {
            const user = await userFieldsFor(deps, c.tenantId, userOf(c));
            return { ...(await identity()), ...user };
          });
          return;
        case 'canceled':
          events.emit(c.tenantId, 'workflow.cancelled', identity);
          return;
        default:
          return;
      }
    },

    runCancelled(c: CancelContext) {
      streamOf(deps)?.emit(c.tenantId, 'workflow.cancelled', () =>
        runIdentity(deps, c, {
          workflowName: c.definition?.name,
          projectId: c.options?.projectId,
          userId: c.options?.userId ?? c.options?.endUserId,
        }),
      );
    },

    crash(c: CrashContext) {
      // the crash text is not sent: the context says nothing of the run's redaction, so no run text leaves
      streamOf(deps)?.emit(c.tenantId, 'workflow.failed', async () => ({
        ...(await runIdentity(deps, c, {
          workflowName: c.definition?.name,
          projectId: c.options?.projectId,
          userId: c.options?.userId ?? c.options?.endUserId,
        })),
        success: false,
        ...(c.state?.resultData.lastNodeExecuted
          ? { lastNodeExecuted: c.state.resultData.lastNodeExecuted }
          : {}),
      }));
    },
  };
}

/** n8n's node event payload; the definition is in hand, so it needs no read */
function nodePayload(c: RunScope, nodeName: string, nodeType: string): DataObject {
  return {
    workflowId: c.row.workflowId,
    workflowName: c.definition.name,
    executionId: c.executionId,
    nodeType,
    nodeName,
    nodeId: c.definition.nodes.find((node) => node.name === nodeName)?.id ?? null,
  };
}
