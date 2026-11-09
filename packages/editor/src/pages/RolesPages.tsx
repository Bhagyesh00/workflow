/**
 * P6-46: `/settings/roles` (tabs: project roles, instance roles; `role:manage`) and the role editor at
 * `/settings/project-roles/{new,edit/:slug,view/:slug}` and `/settings/instance-roles/{...}`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { errorMessage } from '../api/client';
import { rolesApi } from '../api/endpoints';
import { queryKeys, useMe, useRoles } from '../api/queries';
import type { Scope } from '../api/types';
import { RoleAssignments } from '../components/roles/RoleAssignments';
import { type RoleDraft, RoleEditor } from '../components/roles/RoleEditor';
import { RolePresets } from '../components/roles/RolePresets';
import { RolesTable, roleEditorPath } from '../components/roles/RolesTable';
import { Button } from '../components/ui/Button';
import { Callout, EmptyState, PageLoader } from '../components/ui/misc';
import { Tabs } from '../components/ui/Tabs';
import { usePermissions } from '../lib/permissions';
import { toast } from '../stores/ui-store';

export type RoleKind = 'project' | 'global';

const KIND_LABEL: Record<RoleKind, string> = { project: 'project', global: 'workspace' };

/** project roles need `role:manageProject` or `role:manage`; workspace roles `role:manage` */
function useCanManage(): { loading: boolean; project: boolean; global: boolean } {
  const me = useMe();
  const { can } = usePermissions();
  const global = can('role:manage');
  return { loading: me.isPending, global, project: global || can('role:manageProject') };
}

function NoAccess() {
  return (
    <EmptyState
      title="You cannot manage roles"
      description="Ask an owner or admin for the role permission."
    />
  );
}

export function RolesPage() {
  const access = useCanManage();
  const roles = useRoles(access.project);
  const [params, setParams] = useSearchParams();
  const wanted: RoleKind = params.get('type') === 'global' ? 'global' : 'project';
  const tab: RoleKind =
    wanted === 'global' && access.global ? 'global' : access.project ? 'project' : 'global';

  if (access.loading) return <PageLoader />;
  if (!access.project && !access.global) return <NoAccess />;

  const items = [
    ...(access.project ? [{ value: 'project' as const, label: 'Project roles' }] : []),
    ...(access.global ? [{ value: 'global' as const, label: 'Workspace roles' }] : []),
  ];
  const list = roles.data?.[tab] ?? [];

  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Roles</h2>
          <p className="text-sm text-ink-2">
            {tab === 'project'
              ? 'A project role says what a member can do inside one project.'
              : 'A workspace role says what a member can do across the whole workspace.'}
          </p>
        </div>
        <Link
          to={roleEditorPath(tab, 'new')}
          className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white"
        >
          New role
        </Link>
      </div>
      <Tabs
        label="Role types"
        items={items}
        value={tab}
        onChange={(value) => setParams(value === 'global' ? { type: 'global' } : {}, { replace: true })}
      />
      {roles.isPending && <PageLoader label="Loading roles" />}
      {roles.isError && <Callout tone="err">{errorMessage(roles.error)}</Callout>}
      {roles.isSuccess && <RolesTable roleType={tab} roles={list} />}
    </section>
  );
}

export interface RoleEditorPageProps {
  roleType: RoleKind;
  mode: 'new' | 'edit' | 'view';
  /** set in 'edit' and 'view' (the route's `:slug`) */
  slug?: string;
}

const EMPTY_DRAFT: RoleDraft = { displayName: '', description: '', scopes: [] };

export function RoleEditorPage({ roleType, mode, slug }: RoleEditorPageProps) {
  const access = useCanManage();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<RoleDraft>(EMPTY_DRAFT);
  const [tab, setTab] = useState<'role' | 'assignments'>('role');
  const allowed = roleType === 'project' ? access.project : access.global;

  const role = useQuery({
    queryKey: queryKeys.role(slug ?? ''),
    queryFn: () => rolesApi.get(slug ?? ''),
    enabled: mode !== 'new' && Boolean(slug) && allowed,
  });
  const loaded = role.data;
  const seeded = useRef('');
  useEffect(() => {
    // seed the form once per saved version, so a background refetch never wipes what is typed
    const version = loaded ? `${loaded.slug}@${loaded.updatedAt ?? ''}` : '';
    if (!loaded || seeded.current === version) return;
    seeded.current = version;
    setDraft({
      displayName: loaded.displayName,
      description: loaded.description ?? '',
      scopes: loaded.scopes,
    });
  }, [loaded]);

  const back = `/settings/roles${roleType === 'global' ? '?type=global' : ''}`;
  const save = useMutation({
    mutationFn: () => {
      const body = {
        displayName: draft.displayName.trim(),
        description: draft.description.trim(),
        scopes: draft.scopes as Scope[],
      };
      return mode === 'new' ? rolesApi.create({ ...body, roleType }) : rolesApi.update(slug ?? '', body);
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.roles });
      toast.success(mode === 'new' ? `Created ${saved.displayName}` : `Saved ${saved.displayName}`);
      navigate(back);
    },
    onError: (error) =>
      toast.error(
        mode === 'new' ? "Couldn't create the role" : "Couldn't save the role",
        errorMessage(error),
      ),
  });

  if (access.loading) return <PageLoader />;
  if (!allowed) return <NoAccess />;
  if (mode !== 'new') {
    if (role.isPending) return <PageLoader label="Loading role" />;
    if (role.isError || !loaded || loaded.roleType !== roleType) {
      return (
        <EmptyState
          title="Role not found"
          description="It may have been deleted."
          action={
            <Link className="text-sm text-brand hover:underline" to={back}>
              Back to roles
            </Link>
          }
        />
      );
    }
  }

  const readOnly = mode === 'view' || Boolean(loaded?.systemRole);
  const nameOk = draft.displayName.trim().length >= 2;
  const title =
    mode === 'new'
      ? `New ${KIND_LABEL[roleType]} role`
      : readOnly
        ? (loaded?.displayName ?? 'Role')
        : `Edit ${loaded?.displayName ?? 'role'}`;

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <div>
        <Link className="text-sm text-brand hover:underline" to={back}>
          Back to roles
        </Link>
        <h2 className="mt-1 text-lg font-semibold">{title}</h2>
        {loaded?.systemRole && (
          <p className="text-sm text-ink-2">System roles are built in and cannot be changed.</p>
        )}
      </div>

      {mode !== 'new' && (
        <Tabs
          label="Role sections"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'role', label: 'Role' },
            { value: 'assignments', label: 'Assignments' },
          ]}
        />
      )}

      {tab === 'role' ? (
        <>
          {mode === 'new' && (
            <RolePresets
              roleType={roleType}
              onPick={(scopes) => setDraft((d) => ({ ...d, scopes }))}
              disabled={save.isPending}
            />
          )}
          <RoleEditor
            roleType={roleType}
            value={draft}
            onChange={setDraft}
            readOnly={readOnly || save.isPending}
          />
          {!readOnly && (
            <div className="flex gap-2">
              <Button
                variant="primary"
                disabled={!nameOk}
                loading={save.isPending}
                onClick={() => save.mutate()}
              >
                {mode === 'new' ? 'Create role' : 'Save changes'}
              </Button>
              <Button variant="secondary" disabled={save.isPending} onClick={() => navigate(back)}>
                Cancel
              </Button>
            </div>
          )}
        </>
      ) : (
        slug && <RoleAssignments slug={slug} roleType={roleType} />
      )}
    </section>
  );
}
