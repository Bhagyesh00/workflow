import type { ExecutionErrorShape, WorkflowNode } from './interfaces';

export class WorkflowError extends Error {
  description?: string;
  context: Record<string, unknown> = {};
  timestamp = Date.now();

  constructor(message: string, options?: { description?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.description = options?.description;
  }

  toJSON(): ExecutionErrorShape {
    return {
      name: this.name,
      message: this.message,
      description: this.description,
      stack: this.stack,
      timestamp: this.timestamp,
      context: Object.keys(this.context).length ? this.context : undefined,
    };
  }
}

/** Error raised by a node for a problem in its own logic or configuration. */
export class NodeOperationError extends WorkflowError {
  node: string;
  itemIndex?: number;

  constructor(
    node: WorkflowNode | string,
    message: string,
    options?: { description?: string; itemIndex?: number; cause?: unknown },
  ) {
    super(message, options);
    this.node = typeof node === 'string' ? node : node.name;
    this.itemIndex = options?.itemIndex;
    if (options?.itemIndex !== undefined) this.context.itemIndex = options.itemIndex;
  }

  override toJSON(): ExecutionErrorShape {
    return { ...super.toJSON(), node: this.node };
  }
}

/** Error raised when a remote API call fails. */
export class NodeApiError extends NodeOperationError {
  httpCode?: string;
  responseBody?: unknown;

  constructor(
    node: WorkflowNode | string,
    message: string,
    options?: {
      description?: string;
      httpCode?: number | string;
      responseBody?: unknown;
      itemIndex?: number;
      cause?: unknown;
    },
  ) {
    super(node, message, options);
    this.httpCode = options?.httpCode !== undefined ? String(options.httpCode) : undefined;
    this.responseBody = options?.responseBody;
  }

  override toJSON(): ExecutionErrorShape {
    return { ...super.toJSON(), httpCode: this.httpCode };
  }
}

export class WorkflowOperationError extends WorkflowError {}

export class ExpressionError extends WorkflowError {}

export class ExecutionCancelledError extends WorkflowError {
  constructor(reason = 'Execution was cancelled') {
    super(reason);
  }
}

export class ExecutionTimeoutError extends WorkflowError {
  constructor(seconds: number) {
    super(`Execution exceeded the timeout of ${seconds}s`);
  }
}

export function serializeError(error: unknown, node?: string): ExecutionErrorShape {
  if (error instanceof WorkflowError) {
    const json = error.toJSON();
    return node && !json.node ? { ...json, node } : json;
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack, node, timestamp: Date.now() };
  }
  return { name: 'Error', message: String(error), node, timestamp: Date.now() };
}
