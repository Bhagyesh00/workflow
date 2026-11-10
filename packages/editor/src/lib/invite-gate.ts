/**
 * P6-13: the Members page's Invite button: disabled while SSO or workspace role provisioning manages
 * members, with the tooltip text as `reason`.
 *
 * SSO is read from the public sign-in options of this workspace (every role may ask), so a member sees the
 * same answer as an admin. Provisioning is read from `GET /sso/provisioning/config`, which needs
 * `provisioning:manage`: a 403 means "not provisioned" for this reader. SCIM lets invitations through (the
 * server allows them), so the SSO block lifts when SCIM is on; only a `scim:manage` reader can see that.
 */
import { useQuery } from '@tanstack/react-query';
import { isApiError } from '../api/client';
import { authApi, provisioningApi, scimApi } from '../api/endpoints';
import { queryKeys, useMe } from '../api/queries';
import { usePermissions } from './permissions';

export interface InviteGate {
  disabled: boolean;
  reason?: string;
}

export function useInviteGate(): InviteGate {
  const me = useMe().data;
  const slug = me?.tenant.slug;
  const { can } = usePermissions();
  const options = useQuery({
    queryKey: queryKeys.ssoOptions(slug),
    queryFn: () => authApi.ssoOptions(slug),
    enabled: Boolean(slug),
  });
  const provisioning = useQuery({
    queryKey: ['sso', 'provisioning-gate'],
    queryFn: async () => {
      try {
        return await provisioningApi.config();
      } catch (error) {
        if (isApiError(error, 403)) return null;
        throw error;
      }
    },
    enabled: Boolean(slug),
    retry: false,
  });
  const method = options.data?.method;
  const ssoOn = method === 'saml' || method === 'oidc';
  const scim = useQuery({
    queryKey: queryKeys.scimConfig,
    queryFn: scimApi.config,
    enabled: ssoOn && can('scim:manage'),
    retry: false,
  });

  if (provisioning.data?.scopesProvisionInstanceRole) {
    return {
      disabled: true,
      reason: 'Roles come from your identity provider, so people are added there and not by invitation.',
    };
  }
  if (ssoOn && !scim.data?.enabled) {
    return {
      disabled: true,
      reason: `Members are managed by your identity provider while ${method === 'saml' ? 'SAML' : 'OIDC'} sign-in is on.`,
    };
  }
  return { disabled: false };
}
