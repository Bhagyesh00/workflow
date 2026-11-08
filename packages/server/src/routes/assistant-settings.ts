/**
 * GET and PATCH /rest/assistant/settings (P5-71, lane L8): the workspace's Assistant settings, admin
 * only. Not behind the Assistant's on/off gate, so an admin can turn it back on. The role gate and rate
 * limits are final from C0; the handlers are L8's (`AssistantSettingsService.dto` and `patch`).
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireRole } from '../http/auth';
import { assistantRouteOptions } from './assistant';

export function registerAssistantSettingsRoutes(rest: FastifyInstance, _ctx: ServerContext): void {
  rest.get('/assistant/settings', assistantRouteOptions('settings-read', 'read'), async (request) => {
    requireRole(request, 'admin');
    throw new Error('not implemented (L8)');
  });

  rest.patch('/assistant/settings', assistantRouteOptions('settings-patch', 'write'), async (request) => {
    requireRole(request, 'admin');
    throw new Error('not implemented (L8)');
  });
}
