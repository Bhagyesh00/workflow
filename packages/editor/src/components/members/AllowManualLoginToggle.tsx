/**
 * P6-13: Members row switch (`user:update`): this member may sign in with a password while SSO is on. It shows
 * only while SAML or OIDC is the workspace's method, and never on an owner (owners always may).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../../api/client';
import { authApi, ssoApi } from '../../api/endpoints';
import { queryKeys, useMe } from '../../api/queries';
import type { Member } from '../../api/types';
import { usePermissions } from '../../lib/permissions';
import { toast } from '../../stores/ui-store';
import { Switch } from '../ui/Field';

export interface AllowManualLoginToggleProps {
  member: Member;
}

export function AllowManualLoginToggle({ member }: AllowManualLoginToggleProps) {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const slug = useMe().data?.tenant.slug;
  const options = useQuery({
    queryKey: queryKeys.ssoOptions(slug),
    queryFn: () => authApi.ssoOptions(slug),
    enabled: Boolean(slug) && can('user:update'),
  });
  const save = useMutation({
    mutationFn: (allow: boolean) => ssoApi.memberSettings(member.userId, { allowSsoManualLogin: allow }),
    onSuccess: async (_result, allow) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.members });
      toast.success(allow ? 'Password sign-in allowed' : 'Password sign-in not allowed');
    },
    onError: (error) => toast.error('Could not change password sign-in', errorMessage(error)),
  });

  const method = options.data?.method;
  if (!can('user:update') || (method !== 'saml' && method !== 'oidc') || member.role === 'owner') return null;
  const who = member.name || member.email;
  const checked = save.isPending ? Boolean(save.variables) : Boolean(member.allowSsoManualLogin);
  return (
    <span className="flex items-center gap-1.5 text-xs text-ink-2">
      <span aria-hidden="true">Password sign-in</span>
      <Switch
        size="sm"
        label={`Allow password sign-in for ${who}`}
        checked={checked}
        disabled={save.isPending}
        onChange={(allow) => save.mutate(allow)}
      />
    </span>
  );
}
