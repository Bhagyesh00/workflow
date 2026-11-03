/**
 * /rest/annotation-tags (P3-09).
 *
 * C0 STUB: lane L9 registers the routes here. Every route checks access with requireRole
 * (viewer 403 on writes) and scopes by tenant (other tenant 404).
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';

export function registerAnnotationTagRoutes(_app: FastifyInstance, _ctx: ServerContext): void {}
