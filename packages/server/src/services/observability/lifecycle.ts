/**
 * P6-58, P6-59, P6-66 (S5 C0, FULL, C0-final): the run lifecycle hooks the execution service calls (wired by C0d) and the
 * observers that listen: execution events (L1), AI events (L2) and tracing (L10), in that order. Every hook is
 * optional and may return a promise; `LifecycleObservers` awaits the observers one after another, catches and logs
 * each failure (never with run data) and never throws, so an observer never fails, slows into an error or changes a
 * run.
 *
 * Redaction (S3): `NodeEndContext`, `RunEndContext` and `AiEventContext` carry the run's `redaction` channels and
 * `redacted` (the channel of the run's mode: `manual` for a manual run, `production` for every other mode). An
 * observer leaves run text (error messages, node tag values, AI messages) out when `redacted` is true.
 */
import type {
  AiEventName,
  ExecutionErrorShape,
  ExecutionMode,
  ExecutionState,
  ExecutionStatus,
  RedactionChannels,
  TaskData,
  WorkflowDefinition,
} from '@workflow/workflow';
import type { PinoLogger } from '../../logger';
import type { StoredRunOptions } from '../executions';

/** the execution row fields every observer may read */
export interface LifecycleRow {
  mode: ExecutionMode | string;
  workflowId: string | null;
  parentExecutionId: string | null;
  retryOf: string | null;
  startedAt: Date | null;
  stoppedAt: Date | null;
}

/** what every hook gets */
export interface ExecutionScope {
  tenantId: string;
  executionId: string;
  row: LifecycleRow;
}

/** what every hook of a run that is executing gets */
export interface RunScope extends ExecutionScope {
  definition: WorkflowDefinition;
  options: StoredRunOptions;
  /** a first run, or a resume of a waiting run */
  kind: 'run' | 'resume';
}

/** what the hooks that may carry run text get (S3 redaction) */
export interface RedactionScope {
  /** the run's channels (`runEnd`: merged with the sub-workflows' reports; node and AI events: the live holder) */
  redaction: RedactionChannels;
  /** true when the channel of the run's mode applies: run text stays out of events, spans and attributes */
  redacted: boolean;
}

export type RunStartContext = RunScope;

export interface NodeStartContext extends RunScope {
  nodeName: string;
  nodeType: string;
  runIndex: number;
}

export interface NodeEndContext extends RunScope, RedactionScope {
  nodeName: string;
  nodeType: string;
  runIndex: number;
  taskData: TaskData;
}

export interface RunEndContext extends RunScope, RedactionScope {
  /** every final status, `waiting` included */
  status: ExecutionStatus;
  error?: ExecutionErrorShape;
  state?: ExecutionState;
}

/** a `new` or `waiting` execution canceled before it reached `finish` */
export interface CancelContext extends ExecutionScope {
  definition?: WorkflowDefinition;
  options?: StoredRunOptions;
}

export interface CrashContext extends ExecutionScope {
  /** `startup`: `markCrashed`; `persist`: the run's own catch; `worker`: a redelivered queue job */
  detector: 'startup' | 'persist' | 'worker';
  /** the crash message stored on the row */
  error?: string;
  definition?: WorkflowDefinition;
  options?: StoredRunOptions;
  state?: ExecutionState;
}

export interface AiEventContext extends RunScope, RedactionScope {
  name: AiEventName;
  nodeName: string;
  nodeType: string;
  /** the node's message; only the tenant's own destinations may get it, and never when `redacted` */
  msg: string;
}

type Awaitable = void | Promise<void>;

export interface LifecycleObserver {
  runStart?(c: RunStartContext): Awaitable;
  nodeStart?(c: NodeStartContext): Awaitable;
  nodeEnd?(c: NodeEndContext): Awaitable;
  runEnd?(c: RunEndContext): Awaitable;
  runCancelled?(c: CancelContext): Awaitable;
  crash?(c: CrashContext): Awaitable;
  aiEvent?(c: AiEventContext): Awaitable;
}

type Hook = keyof LifecycleObserver;

export class LifecycleObservers {
  private readonly observers: LifecycleObserver[] = [];

  constructor(private readonly logger: Pick<PinoLogger, 'warn'>) {}

  add(observer: LifecycleObserver): void {
    this.observers.push(observer);
  }

  /** tests: removes an observer added before */
  remove(observer: LifecycleObserver): void {
    const index = this.observers.indexOf(observer);
    if (index >= 0) this.observers.splice(index, 1);
  }

  runStart(c: RunStartContext): Promise<void> {
    return this.call('runStart', c);
  }

  nodeStart(c: NodeStartContext): Promise<void> {
    return this.call('nodeStart', c);
  }

  nodeEnd(c: NodeEndContext): Promise<void> {
    return this.call('nodeEnd', c);
  }

  runEnd(c: RunEndContext): Promise<void> {
    return this.call('runEnd', c);
  }

  runCancelled(c: CancelContext): Promise<void> {
    return this.call('runCancelled', c);
  }

  crash(c: CrashContext): Promise<void> {
    return this.call('crash', c);
  }

  aiEvent(c: AiEventContext): Promise<void> {
    return this.call('aiEvent', c);
  }

  private async call<H extends Hook>(
    hook: H,
    c: Parameters<NonNullable<LifecycleObserver[H]>>[0],
  ): Promise<void> {
    for (const observer of [...this.observers]) {
      const fn = observer[hook] as ((context: typeof c) => Awaitable) | undefined;
      if (!fn) continue;
      try {
        await fn.call(observer, c);
      } catch (error) {
        this.logger.warn(
          { err: error, hook, tenantId: c.tenantId, executionId: c.executionId },
          'A run lifecycle observer failed',
        );
      }
    }
  }
}
