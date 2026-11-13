/**
 * P6-42: `/projects/:id/settings`: name, icon, description, the vault section (`ProjectVaultSection`, L22),
 * members with search, role dropdown and remove, and the danger zone (`DeleteProjectDialog`).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage, isApiError } from '../api/client';
import { membersApi, projectsApi } from '../api/endpoints';
import { queryKeys, useProject, useRoles } from '../api/queries';
import type { ProjectIcon, TelemetryTag } from '../api/types';
import { DeleteProjectDialog } from '../components/projects/DeleteProjectDialog';
import { IconPicker } from '../components/projects/IconPicker';
import { ProjectMembersTable } from '../components/projects/ProjectMembersTable';
import { ProjectVaultSection } from '../components/projects/ProjectVaultSection';
import { ProjectTelemetryTags } from '../components/telemetry/ProjectTelemetryTags';
import { Button } from '../components/ui/Button';
import { FormField, Select, TextArea, TextInput } from '../components/ui/Field';
import { Callout, EmptyState, PageLoader } from '../components/ui/misc';
import { usePermissions } from '../lib/permissions';
import { toast } from '../stores/ui-store';

export interface ProjectSettingsPageProps {
  projectId: string;
}

export function ProjectSettingsPage({ projectId }: ProjectSettingsPageProps) {
  const project = useProject(projectId);
  const roles = useRoles();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detail = project.data;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState<ProjectIcon | null>(null);
  // P6-67: custom OpenTelemetry attributes of this project's spans
  const [tags, setTags] = useState<TelemetryTag[]>([]);
  // a row is invalid: `tags` holds the last valid list, so Save waits
  const [tagsInvalid, setTagsInvalid] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [candidate, setCandidate] = useState('');
  const [newRole, setNewRole] = useState('project:viewer');

  const detailId = detail?.id;
  const detailName = detail?.name;
  const detailDescription = detail?.description;
  const detailIcon = detail?.icon;
  const detailTags = detail?.customTelemetryTags;
  useEffect(() => {
    if (!detailId) return;
    setName(detailName ?? '');
    setDescription(detailDescription ?? '');
    setIcon(detailIcon ?? null);
    setTags(detailTags ?? []);
  }, [detailId, detailName, detailDescription, detailIcon, detailTags]);

  const canUpdate = can('project:update', detail);
  const canMembers = can('project:manageMembers', detail);
  const canDelete = can('project:delete', detail);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.myProjects });
  };
  const fail = (title: string) => (error: unknown) => toast.error(title, errorMessage(error));

  const save = useMutation({
    mutationFn: () =>
      projectsApi.update(projectId, {
        name: name.trim(),
        description,
        ...(icon ? { icon } : {}),
        customTelemetryTags: tags,
      }),
    onSuccess: async () => {
      await refresh();
      toast.success('Project saved');
    },
    onError: fail("Couldn't save the project"),
  });
  const changeRole = useMutation({
    mutationFn: (v: { userId: string; role: string }) =>
      projectsApi.changeUserRole(projectId, v.userId, v.role),
    onSuccess: refresh,
    onError: fail("Couldn't change the role"),
  });
  const removeUser = useMutation({
    mutationFn: (userId: string) => projectsApi.removeUser(projectId, userId),
    onSuccess: refresh,
    onError: fail("Couldn't remove the member"),
  });
  const addUser = useMutation({
    mutationFn: () => projectsApi.addUsers(projectId, [{ userId: candidate, role: newRole }]),
    onSuccess: async (result) => {
      setCandidate('');
      await refresh();
      if (result?.conflicts?.length) toast.error('Already a member', 'That user is already in this project.');
    },
    onError: fail("Couldn't add the member"),
  });

  const users = useQuery({
    queryKey: ['members'],
    queryFn: membersApi.list,
    enabled: Boolean(detail) && canMembers,
    retry: false,
  });

  if (project.isLoading) return <PageLoader label="Loading the project" />;
  if (project.error || !detail) {
    return (
      <EmptyState
        className="h-full"
        title={isApiError(project.error, 404) ? 'Project not found' : 'You cannot open this project'}
        description={project.error ? errorMessage(project.error) : undefined}
      />
    );
  }
  if (detail.type === 'personal') {
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <Callout title="Personal project">A personal project has no settings of its own.</Callout>
      </div>
    );
  }

  const projectRoles = roles.data?.project ?? [];
  const assignable = projectRoles.filter((r) => r.slug !== 'project:personalOwner');
  const taken = new Set([...detail.relations.map((r) => r.id), ...detail.implicitMembers.map((m) => m.id)]);
  const addable = (users.data ?? []).filter((m) => m.status !== 'pending' && !taken.has(m.userId));
  const trimmed = name.trim();
  const dirty =
    trimmed !== detail.name ||
    description !== (detail.description ?? '') ||
    JSON.stringify(icon) !== JSON.stringify(detail.icon) ||
    JSON.stringify(tags) !== JSON.stringify(detail.customTelemetryTags ?? []);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
      <section aria-labelledby="ps-general" className="flex flex-col gap-4">
        <h2 id="ps-general" className="text-base font-semibold text-ink">
          Project settings
        </h2>
        <FormField label="Project name" required>
          {(id) => (
            <TextInput
              id={id}
              value={name}
              maxLength={255}
              disabled={!canUpdate}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </FormField>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-ink">Project icon</span>
          <IconPicker value={icon} onChange={setIcon} disabled={!canUpdate} />
        </div>
        <FormField label="Description">
          {(id) => (
            <TextArea
              id={id}
              rows={3}
              value={description}
              maxLength={512}
              disabled={!canUpdate}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </FormField>
        {/* P6-67 (L11): custom OpenTelemetry attributes, `project.custom.<key>` on this project's spans */}
        <ProjectTelemetryTags
          value={tags}
          onChange={setTags}
          onValidityChange={setTagsInvalid}
          disabled={!canUpdate}
        />
        {canUpdate && (
          <div>
            <Button
              variant="primary"
              disabled={!dirty || trimmed.length === 0 || tagsInvalid}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              Save
            </Button>
          </div>
        )}
      </section>

      <ProjectVaultSection projectId={projectId} />

      <section aria-labelledby="ps-members" className="flex flex-col gap-4">
        <h2 id="ps-members" className="text-base font-semibold text-ink">
          Project members
        </h2>
        {canMembers && (
          <div className="flex flex-wrap items-end gap-2">
            <FormField label="Add a member" className="min-w-56 flex-1">
              {(id) => (
                <Select id={id} value={candidate} onChange={(e) => setCandidate(e.target.value)}>
                  <option value="">Choose a user</option>
                  {addable.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name ? `${m.name} (${m.email})` : m.email}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField label="Role for the new member">
              {(id) => (
                <Select id={id} value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                  {assignable.map((r) => (
                    <option key={r.slug} value={r.slug}>
                      {r.displayName}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <Button
              variant="primary"
              disabled={!candidate}
              loading={addUser.isPending}
              onClick={() => addUser.mutate()}
            >
              Add member
            </Button>
          </div>
        )}
        <ProjectMembersTable
          project={detail}
          roles={projectRoles}
          editable={canMembers}
          onChangeRole={(userId, role) => changeRole.mutate({ userId, role })}
          onRemove={(userId) => removeUser.mutate(userId)}
        />
      </section>

      {canDelete && (
        <section
          aria-labelledby="ps-danger"
          className="flex flex-col gap-3 rounded-lg border border-err/40 p-4"
        >
          <h2 id="ps-danger" className="text-base font-semibold text-err">
            Danger zone
          </h2>
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-ink-2">
              Delete this project and move or remove its workflows, credentials, data tables and folders.
            </p>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              Delete project
            </Button>
          </div>
        </section>
      )}
      {deleting && (
        <DeleteProjectDialog
          project={detail}
          onClose={() => setDeleting(false)}
          onDeleted={() => navigate('/home/workflows')}
        />
      )}
    </div>
  );
}
