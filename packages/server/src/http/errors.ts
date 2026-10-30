/**
 * API errors. Every error response has the shape `{ error: { code, message, details? } }`
 * with a matching HTTP status (ARCHITECTURE.md §14).
 */
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, 'bad_request', message, details);
  }
  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, 'unauthorized', message);
  }
  static forbidden(message = 'You do not have permission to perform this action') {
    return new ApiError(403, 'forbidden', message);
  }
  static notFound(what = 'Resource') {
    return new ApiError(404, 'not_found', `${what} not found`);
  }
  static conflict(message: string, details?: unknown) {
    return new ApiError(409, 'conflict', message, details);
  }
  static planLimit(message: string) {
    return new ApiError(403, 'plan_limit', message);
  }
  static tooMany(message: string) {
    return new ApiError(429, 'rate_limited', message);
  }
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

const FASTIFY_CODES: Record<string, { status: number; code: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: 'payload_too_large' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, code: 'unsupported_media_type' },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: { status: 400, code: 'bad_request' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, code: 'bad_request' },
  FST_ERR_CTP_INVALID_JSON_BODY: { status: 400, code: 'bad_request' },
};

/** Fastify error handler producing the error envelope; never leaks stack traces. */
export function handleError(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ApiError) {
    return reply.status(error.statusCode).send(errorBody(error.code, error.message, error.details));
  }
  if (error instanceof z.ZodError) {
    return reply.status(400).send(
      errorBody(
        'validation_error',
        'Request validation failed',
        error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      ),
    );
  }
  const fe = error as FastifyError;
  if (fe.code && FASTIFY_CODES[fe.code]) {
    const mapped = FASTIFY_CODES[fe.code];
    return reply.status(mapped.status).send(errorBody(mapped.code, fe.message));
  }
  if (fe.statusCode === 429) {
    return reply.status(429).send(errorBody('rate_limited', 'Too many requests, please try again later'));
  }
  if (fe.validation) {
    return reply.status(400).send(errorBody('validation_error', fe.message));
  }
  if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
    return reply.status(fe.statusCode).send(errorBody('bad_request', fe.message));
  }
  request.log.error({ err: error }, 'Unhandled error');
  return reply.status(500).send(errorBody('internal_error', 'Internal server error'));
}

/** Parse with a zod schema, raising a 400 validation error on failure. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(
      400,
      'validation_error',
      'Request validation failed',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}
