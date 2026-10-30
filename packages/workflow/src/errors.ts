import type { ExecutionErrorShape, WorkflowNode } from './interfaces';

export class WorkflowError extends Error {
  description?: string;
  context: Record<string, unknown> = {};
  timestamp = Date.now();
  /** stable machine-readable code, e.g. `HTTP_401`, `EXPRESSION_REFERENCE` (see `classifyError`) */
  code?: string;

  constructor(message: string, options?: { description?: string; cause?: unknown; code?: string }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.description = options?.description;
    this.code = options?.code;
  }

  toJSON(): ExecutionErrorShape {
    return {
      name: this.name,
      message: this.message,
      description: this.description,
      code: this.code,
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
  /** parameter that caused the error, if known */
  parameter?: string;

  constructor(
    node: WorkflowNode | string,
    message: string,
    options?: {
      description?: string;
      itemIndex?: number;
      cause?: unknown;
      code?: string;
      parameter?: string;
    },
  ) {
    super(message, options);
    this.node = typeof node === 'string' ? node : node.name;
    this.itemIndex = options?.itemIndex;
    this.parameter = options?.parameter;
    if (options?.itemIndex !== undefined) this.context.itemIndex = options.itemIndex;
  }

  override toJSON(): ExecutionErrorShape {
    return { ...super.toJSON(), node: this.node, itemIndex: this.itemIndex, parameter: this.parameter };
  }
}

export interface HttpRequestSummary {
  method: string;
  /** URL without query string (query values may contain secrets) */
  url: string;
}

export interface HttpResponseSummary {
  statusCode?: number;
  /** body excerpt, truncated */
  body?: string;
}

/** Error raised when a remote API call fails. */
export class NodeApiError extends NodeOperationError {
  httpCode?: string;
  responseBody?: unknown;
  request?: HttpRequestSummary;
  /** milliseconds requested by the server (`Retry-After`) */
  retryAfterMs?: number;

  constructor(
    node: WorkflowNode | string,
    message: string,
    options?: {
      description?: string;
      httpCode?: number | string;
      responseBody?: unknown;
      itemIndex?: number;
      cause?: unknown;
      code?: string;
      request?: HttpRequestSummary;
      retryAfterMs?: number;
    },
  ) {
    super(node, message, options);
    this.httpCode = options?.httpCode !== undefined ? String(options.httpCode) : undefined;
    this.responseBody = options?.responseBody;
    this.request = options?.request;
    this.retryAfterMs = options?.retryAfterMs;
    if (!this.code && this.httpCode) this.code = `HTTP_${this.httpCode}`;
  }

  override toJSON(): ExecutionErrorShape {
    return {
      ...super.toJSON(),
      httpCode: this.httpCode,
      request: this.request,
      response:
        this.httpCode || this.responseBody !== undefined
          ? {
              statusCode: this.httpCode ? Number(this.httpCode) : undefined,
              body: excerpt(this.responseBody),
            }
          : undefined,
    };
  }
}

export class WorkflowOperationError extends WorkflowError {}

export class ExpressionError extends WorkflowError {}

export class ExecutionCancelledError extends WorkflowError {
  constructor(reason = 'Execution was cancelled') {
    super(reason, { code: 'CANCELED' });
  }
}

export class ExecutionTimeoutError extends WorkflowError {
  constructor(seconds: number) {
    super(`Execution exceeded the timeout of ${seconds}s`, { code: 'EXECUTION_TIMEOUT' });
  }
}

/** A per-execution resource quota was exceeded (items, node runs, ...). */
export class QuotaExceededError extends WorkflowError {
  constructor(message: string) {
    super(message, { code: 'QUOTA_EXCEEDED' });
  }
}

const SECRET_KEYS = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|session|private[-_]?key/i;

/** Truncated, secret-scrubbed string form of a response body for error reports. */
export function excerpt(body: unknown, max = 2000): string | undefined {
  if (body === undefined || body === null) return undefined;
  let text: string;
  if (typeof body === 'string') text = body;
  else if (body instanceof Uint8Array) text = `<${body.byteLength} bytes>`;
  else {
    try {
      text = JSON.stringify(body, (k, v) => (k && SECRET_KEYS.test(k) ? '[redacted]' : v));
    } catch {
      text = String(body);
    }
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

interface Classification {
  code: string;
  hint?: string;
}

const HTTP_HINTS: Record<string, string> = {
  '400': 'The service rejected the request. Check the parameters and body against its API documentation.',
  '401':
    'Authentication failed. Reconnect or update the credential; tokens may have expired or been revoked.',
  '403':
    'The credential is valid but not allowed to do this. Check its scopes or permissions in the service.',
  '404':
    'The resource was not found. Check IDs and the URL; it may have been deleted or belong to another account.',
  '409':
    'The request conflicts with the current state of the resource (for example a duplicate). Consider an upsert.',
  '413': 'The request body is too large for the service. Send smaller batches.',
  '422': 'The service could not process the data. Check required fields and value formats.',
  '429': 'Rate limit reached. Enable "Retry on fail" with exponential backoff or lower the batch size.',
  '500': 'The service had an internal error. Retrying later usually helps.',
  '502': 'The service or a proxy in front of it is unavailable. Retrying later usually helps.',
  '503': 'The service is temporarily unavailable. Retrying later usually helps.',
  '504': 'The service timed out. Retry, or request less data per call.',
};

/** Map any error to a stable code and a plain-language hint (error catalogue). */
export function classifyError(error: ExecutionErrorShape): Classification {
  const msg = error.message ?? '';
  if (error.httpCode) {
    const status = String(error.httpCode);
    return {
      code: error.code ?? `HTTP_${status}`,
      hint: HTTP_HINTS[status] ?? (status.startsWith('5') ? HTTP_HINTS['500'] : undefined),
    };
  }
  if (error.code === 'CANCELED' || error.code === 'EXECUTION_TIMEOUT' || error.code === 'QUOTA_EXCEEDED') {
    return {
      code: error.code,
      hint:
        error.code === 'EXECUTION_TIMEOUT'
          ? 'Increase the workflow timeout in its settings or split the work into sub-workflows.'
          : error.code === 'QUOTA_EXCEEDED'
            ? 'Process data in smaller batches (Loop Over Items) or ask an admin to raise the limit.'
            : undefined,
    };
  }
  if (error.name === 'SsrfBlockedError' || /is blocked: private, loopback/.test(msg)) {
    return {
      code: 'SSRF_BLOCKED',
      hint: 'Requests to private, loopback and cloud-metadata addresses are blocked for security. Use a public URL, or ask an admin to allow-list the host.',
    };
  }
  if (/timed out|TimeoutError|ETIMEDOUT/i.test(`${error.name} ${msg}`)) {
    return {
      code: 'TIMEOUT',
      hint: 'The operation took too long. Raise the timeout option or reduce the amount of data per call.',
    };
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) {
    return { code: 'NETWORK_DNS', hint: 'The hostname could not be resolved. Check the URL for typos.' };
  }
  if (/ECONNREFUSED|ECONNRESET|socket hang up|fetch failed/i.test(msg)) {
    return {
      code: 'NETWORK',
      hint: 'The connection failed. Check that the service is reachable and the port is correct.',
    };
  }
  if (error.name === 'ExpressionError') {
    if (/is not defined/.test(msg)) {
      const name = /^(\S+) is not defined/.exec(msg)?.[1];
      return {
        code: 'EXPRESSION_REFERENCE',
        hint:
          name && !name.startsWith('$')
            ? `"${name}" is not a variable here. Did you mean $json.${name}?`
            : 'The expression references a variable that does not exist.',
      };
    }
    if (/paired item/i.test(msg)) {
      return {
        code: 'EXPRESSION_PAIRED_ITEM',
        hint: 'A node between here and the referenced node does not link its output items to its inputs. Use $("Node").first() or .all(), or set pairedItem in Code nodes.',
      };
    }
    if (/has not been executed/.test(msg)) {
      return {
        code: 'EXPRESSION_NODE_NOT_EXECUTED',
        hint: 'The referenced node did not run before this one. Check the connections or run the workflow from the start.',
      };
    }
    if (/Invalid syntax/.test(msg))
      return { code: 'EXPRESSION_SYNTAX', hint: 'Check brackets and quotes in the expression.' };
    if (/maximum|time limit|exceeds/.test(msg)) {
      return {
        code: 'EXPRESSION_LIMIT',
        hint: 'The expression did too much work. Move heavy logic into a Code node.',
      };
    }
    if (/not allowed|disabled/.test(msg)) return { code: 'EXPRESSION_FORBIDDEN' };
    return { code: 'EXPRESSION' };
  }
  if (error.name === 'CodeExecutionError') {
    if (/timed out/.test(msg))
      return { code: 'CODE_TIMEOUT', hint: 'The code ran too long. Look for endless loops.' };
    if (/memory limit/.test(msg))
      return { code: 'CODE_MEMORY', hint: 'The code used too much memory. Process fewer items at a time.' };
    return { code: 'CODE_ERROR' };
  }
  if (/does not have credentials of type/.test(msg)) {
    return { code: 'CREDENTIALS_MISSING', hint: 'Select a credential for this node in its parameters.' };
  }
  if (/Could not get parameter/.test(msg)) return { code: 'PARAMETER_MISSING' };
  if (error.name === 'WorkflowOperationError') return { code: error.code ?? 'WORKFLOW' };
  return { code: error.code ?? 'NODE_ERROR' };
}

export function serializeError(error: unknown, node?: string): ExecutionErrorShape {
  let shape: ExecutionErrorShape;
  if (error instanceof WorkflowError) {
    const json = error.toJSON();
    shape = node && !json.node ? { ...json, node } : json;
  } else if (error instanceof Error) {
    shape = { name: error.name, message: error.message, stack: error.stack, node, timestamp: Date.now() };
  } else {
    shape = { name: 'Error', message: String(error), node, timestamp: Date.now() };
  }
  const { code, hint } = classifyError(shape);
  return { ...shape, code: shape.code ?? code, hint: shape.hint ?? hint };
}
