/**
 * P6-15: the credential modal's private (per user) part: the type choice (OAuth types,
 * `credential:createEndUser`, not in a personal project), the caller's connect and disconnect, the
 * connected count. Also the small marks other screens show for private credentials: the status on a
 * credential row and the node picker, and the icon on a workflow card and a run.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserRoundKey } from 'lucide-react';
import { errorMessage } from '../../api/client';
import { credentialsApi, privateCredentialsApi } from '../../api/endpoints';
import { queryKeys, useMe } from '../../api/queries';
import type { CredentialSummary, ProjectRef } from '../../api/types';
import { canWith, type ScopedResource } from '../../lib/permissions';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { confirmDialog } from '../ui/Dialog';
import { Switch } from '../ui/Field';
import { Badge } from '../ui/misc';

export interface PrivateCredentialSectionProps {
  /** the saved credential (null until the first save) */
  credentialId: string | null;
  /** the credential type's name */
  typeName: string;
  /** an OAuth1 or OAuth2 type (only those can be private) */
  isOAuth: boolean;
}

export const PRIVATE_LABEL = 'Private credential';
export const PRIVATE_HINT =
  'Each user connects their own account. A run uses the account of the user who starts it.';
export const PRIVATE_PERSONAL_REASON = "Private credentials can't be used in a personal project.";
export const PRIVATE_SCOPE_REASON = "You don't have permission to make private credentials in this project.";

/**
 * Whether the caller may make a credential private in `project` (a project detail or a credential row with
 * its `scopes`), and why not: the project must be a team project and grant `credential:createEndUser`.
 */
export function usePrivateAllowed(
  project: (ScopedResource & { type?: ProjectRef['type'] }) | null | undefined,
): { allowed: boolean; reason?: string } {
  const me = useMe().data;
  if (!project || project.type === 'personal') return { allowed: false, reason: PRIVATE_PERSONAL_REASON };
  if (!canWith(me, 'credential:createEndUser', project)) return { allowed: false, reason: PRIVATE_SCOPE_REASON };
  return { allowed: true };
}

/** the switch between one shared account and each user's own account, with its reason when locked */
export function PrivateTypeChoice({
  value,
  onChange,
  disabled,
  reason,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  reason?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{PRIVATE_LABEL}</p>
        <p className="text-sm text-ink-2">{PRIVATE_HINT}</p>
        {disabled && reason && <p className="mt-1 text-sm text-ink-3">{reason}</p>}
      </div>
      <Switch label={PRIVATE_LABEL} checked={value} onChange={onChange} disabled={disabled} />
    </div>
  );
}

/** a private credential's state on a row: whether the caller connected, and how many users did */
export function PrivateCredentialStatus({
  credential,
}: {
  credential: Pick<CredentialSummary, 'isResolvable' | 'connectedByMe' | 'connectedCount'>;
}) {
  if (!credential.isResolvable) return null;
  const count = credential.connectedCount ?? 0;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone="brand">Private</Badge>
      <Badge tone={credential.connectedByMe ? 'ok' : 'warn'}>
        {credential.connectedByMe ? 'Connected' : 'Not connected'}
      </Badge>
      <span className="text-sm text-ink-3">{`${count} ${count === 1 ? 'user' : 'users'} connected`}</span>
    </span>
  );
}

/** the icon of a workflow that uses a private credential, or of a run that used one */
export function PrivateCredentialsMark({ label }: { label: string }) {
  return (
    <span role="img" aria-label={label} className="inline-flex shrink-0 items-center text-brand">
      <UserRoundKey size={14} aria-hidden="true" />
    </span>
  );
}

/** the saved credential's private part: the switch (PATCH `isResolvable`), the caller's connection, the count */
export function PrivateCredentialSection({ credentialId, isOAuth }: PrivateCredentialSectionProps) {
  const queryClient = useQueryClient();
  const me = useMe().data;
  const detail = useQuery({
    queryKey: queryKeys.credential(credentialId ?? 'new'),
    queryFn: () => credentialsApi.get(credentialId!),
    enabled: isOAuth && Boolean(credentialId),
  });
  const credential = detail.data;
  const gate = usePrivateAllowed(
    credential ? { type: credential.homeProject?.type, scopes: credential.scopes } : null,
  );
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['credentials'] });
    if (credentialId) await queryClient.invalidateQueries({ queryKey: queryKeys.credential(credentialId) });
  };
  const toggle = useMutation({
    mutationFn: (isResolvable: boolean) => credentialsApi.update(credentialId!, { isResolvable }),
    onSuccess: async (_saved, isResolvable) => {
      await refresh();
      toast.success(isResolvable ? 'Credential is private' : 'Credential uses one shared account');
    },
    onError: (error) => toast.error("Couldn't change the credential", errorMessage(error)),
  });
  const disconnect = useMutation({
    mutationFn: () => privateCredentialsApi.disconnect(credentialId!),
    onSuccess: async () => {
      await refresh();
      toast.success('Your account is disconnected');
    },
    onError: (error) => toast.error("Couldn't disconnect your account", errorMessage(error)),
  });

  if (!isOAuth || !credentialId || !credential) return null;
  const isPrivate = credential.isResolvable === true;
  const count = credential.connectedCount ?? 0;
  // switching off needs the scope only; switching on also needs a team project
  const canSwitch = isPrivate ? canWith(me, 'credential:createEndUser', credential) : gate.allowed;
  const reason = isPrivate ? PRIVATE_SCOPE_REASON : gate.reason;

  const onChange = async (next: boolean) => {
    if (!next && count > 0) {
      const ok = await confirmDialog({
        title: 'Use one shared account?',
        description: `The ${count === 1 ? 'connection' : `${count} connections`} of users to this credential will be removed.`,
        confirmLabel: 'Remove connections',
        tone: 'danger',
      });
      if (!ok) return;
    }
    toggle.mutate(next);
  };

  return (
    <section
      aria-label={PRIVATE_LABEL}
      className="flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-4"
    >
      <PrivateTypeChoice
        value={isPrivate}
        onChange={(next) => void onChange(next)}
        disabled={!canSwitch || toggle.isPending}
        reason={canSwitch ? undefined : reason}
      />
      {isPrivate && (
        <div className="flex flex-wrap items-center gap-3">
          <PrivateCredentialStatus credential={credential} />
          {credential.connectedByMe && (
            <Button size="sm" onClick={() => disconnect.mutate()} loading={disconnect.isPending}>
              Disconnect my account
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
