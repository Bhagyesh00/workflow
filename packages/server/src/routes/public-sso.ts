/**
 * Public API SSO config (P6-14, L12): GET and PUT `/settings/sso/saml` (`saml:manage`) and
 * `/settings/sso/oidc` (`oidc:manage`), through `ctx.saml.saveConfig` and `ctx.oidc.saveConfig`. A GET answer
 * can be sent back as the PUT body; secrets are blanked, and a blank keeps the stored one.
 * PUBLIC_SSO_ROUTES is final and shaped as PUBLIC_ROLE_ROUTES (public-api.ts spreads it); the handlers
 * throw until L12 (stub (L12)).
 */
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { ApiRoute, PublicApiInput } from './public-api';

type Handler = (ctx: ServerContext, input: PublicApiInput) => Promise<unknown>;

/** the protocol's config fields (L7 and L8 own the exact shape) */
const configBody = z.record(z.string(), z.unknown());

const notImplemented: Handler = async () => {
  throw new Error('not implemented (L12)');
};

export const publicSsoHandlers: Record<'getSaml' | 'saveSaml' | 'getOidc' | 'saveOidc', Handler> = {
  getSaml: notImplemented,
  saveSaml: notImplemented,
  getOidc: notImplemented,
  saveOidc: notImplemented,
};

const row = (name: keyof typeof publicSsoHandlers, fields: Omit<ApiRoute, 'handler' | 'tag'>): ApiRoute => ({
  ...fields,
  tag: 'SSO',
  /** late bound, so the handler that runs is the one in the table above */
  handler: (ctx, input) => publicSsoHandlers[name](ctx, input),
});

export const PUBLIC_SSO_ROUTES: ApiRoute[] = [
  row('getSaml', {
    method: 'GET',
    path: '/settings/sso/saml',
    summary: 'Get the SAML config (secrets blanked)',
    access: { scope: 'saml:manage' },
    scope: 'saml:manage',
    response: 'SsoConfig',
  }),
  row('saveSaml', {
    method: 'PUT',
    path: '/settings/sso/saml',
    summary: 'Save the SAML config',
    access: { scope: 'saml:manage' },
    scope: 'saml:manage',
    body: configBody,
    response: 'SsoConfig',
  }),
  row('getOidc', {
    method: 'GET',
    path: '/settings/sso/oidc',
    summary: 'Get the OIDC config (the client secret blanked)',
    access: { scope: 'oidc:manage' },
    scope: 'oidc:manage',
    response: 'SsoConfig',
  }),
  row('saveOidc', {
    method: 'PUT',
    path: '/settings/sso/oidc',
    summary: 'Save the OIDC config (a blank client secret keeps the stored one)',
    access: { scope: 'oidc:manage' },
    scope: 'oidc:manage',
    body: configBody,
    response: 'SsoConfig',
  }),
];
