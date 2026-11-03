/**
 * /rest/workflow-reviews and /rest/inbox (P3-19).
 *
 * C0 STUB: lane L14 registers the routes here. Every route checks access with requireRole
 * (viewer 403 on writes) and scopes by tenant (other tenant 404).
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';

export function registerWorkflowReviewRoutes(_app: FastifyInstance, _ctx: ServerContext): void {}
