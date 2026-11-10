/**
 * Public API LDAP (P6-12, L10), n8n's LDAP public controller: GET and PUT `/settings/ldap` (`ldap:manage`),
 * GET `/settings/ldap/sync` (the history) and POST `/settings/ldap/sync` (a run) (`ldap:sync`).
 * PUBLIC_LDAP_ROUTES is final and shaped as PUBLIC_ROLE_ROUTES (public-api.ts spreads it); the handlers
 * throw until L10 (stub (L10)).
 */
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { ApiRoute, PublicApiInput } from './public-api';

type Handler = (ctx: ServerContext, input: PublicApiInput) => Promise<unknown>;

/** the LDAP config fields (L10 owns the exact shape); a blank bind password keeps the stored one */
const configBody = z.record(z.string(), z.unknown());
const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(50),
  cursor: z.string().max(512).optional(),
});
const syncBody = z.object({ type: z.enum(['live', 'dry']).default('live') });

const notImplemented: Handler = async () => {
  throw new Error('not implemented (L10)');
};

export const publicLdapHandlers: Record<'getConfig' | 'saveConfig' | 'history' | 'sync', Handler> = {
  getConfig: notImplemented,
  saveConfig: notImplemented,
  history: notImplemented,
  sync: notImplemented,
};

const row = (name: keyof typeof publicLdapHandlers, fields: Omit<ApiRoute, 'handler' | 'tag'>): ApiRoute => ({
  ...fields,
  tag: 'LDAP',
  /** late bound, so the handler that runs is the one in the table above */
  handler: (ctx, input) => publicLdapHandlers[name](ctx, input),
});

export const PUBLIC_LDAP_ROUTES: ApiRoute[] = [
  row('getConfig', {
    method: 'GET',
    path: '/settings/ldap',
    summary: 'Get the LDAP config (the bind password blanked)',
    access: { scope: 'ldap:manage' },
    scope: 'ldap:manage',
    response: 'LdapConfig',
  }),
  row('saveConfig', {
    method: 'PUT',
    path: '/settings/ldap',
    summary: 'Save the LDAP config (a blank bind password keeps the stored one)',
    access: { scope: 'ldap:manage' },
    scope: 'ldap:manage',
    body: configBody,
    response: 'LdapConfig',
  }),
  row('history', {
    method: 'GET',
    path: '/settings/ldap/sync',
    summary: 'List the LDAP sync runs, newest first',
    access: { scope: 'ldap:sync' },
    scope: 'ldap:sync',
    query: historyQuery,
    response: 'LdapSyncRun',
    list: true,
  }),
  row('sync', {
    method: 'POST',
    path: '/settings/ldap/sync',
    summary: 'Run an LDAP sync (dry runs write nothing but the history row)',
    access: { scope: 'ldap:sync' },
    scope: 'ldap:sync',
    body: syncBody,
    response: 'LdapSyncRun',
  }),
];
