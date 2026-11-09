/**
 * P6-41: the page header of Overview, Shared with you and a project: title (with the project's icon), and
 * the Create button (workflow, credential, folder, data table, variable) gated by the project's scopes.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Scope } from '@workflow/workflow';
import {
  ChevronDown,
  FolderPlus,
  KeyRound,
  Plus,
  Star,
  Table2,
  Variable as VariableIcon,
  Workflow,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage } from '../../api/client';
import { favoritesApi, projectsApi, workflowsApi } from '../../api/endpoints';
import { queryKeys, useFavorites, useProject } from '../../api/queries';
import { usePermissions } from '../../lib/permissions';
import type { ProjectPageKind } from '../../pages/ProjectPages';
import { toast } from '../../stores/ui-store';
import { CredentialModal } from '../credentials/CredentialModal';
import { CredentialTypePicker } from '../credentials/CredentialTypePicker';
import { CreateTableDialog } from '../data-tables/CreateTableDialog';
import { Button } from '../ui/Button';
import { Menu, type MenuItem } from '../ui/Menu';
import { FolderDialog } from '../workflow/FolderDialog';
import { ProjectIconView } from './ProjectNav';

export interface ProjectHeaderProps {
  kind: ProjectPageKind;
  /** set when `kind` is 'project' */
  projectId?: string;
}

type Dialog = null | 'credentialType' | 'folder' | 'table';

const TITLES: Record<'home' | 'shared', { title: string; text: string }> = {
  home: { title: 'Overview', text: 'All the workflows, credentials and executions you have access to.' },
  shared: { title: 'Shared with you', text: 'Workflows and credentials other projects shared with you.' },
};

export function ProjectHeader({ kind, projectId }: ProjectHeaderProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const favorites = useFavorites();
  const project = useProject(kind === 'project' ? projectId : null);
  // Overview creates in the user's personal project
  const personal = useQuery({
    queryKey: queryKeys.personalProject,
    queryFn: projectsApi.personal,
    enabled: kind === 'home',
    staleTime: 60_000,
  });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [credentialType, setCredentialType] = useState<string | null>(null);

  const target = kind === 'project' ? project.data : kind === 'home' ? personal.data : undefined;
  const createWorkflow = useMutation({
    mutationFn: () =>
      workflowsApi.create({ name: 'My workflow', nodes: [], connections: {}, projectId: target?.id }),
    onSuccess: async (dto) => {
      await queryClient.invalidateQueries({ queryKey: ['workflows'] });
      navigate(`/workflow/${encodeURIComponent(dto.id)}`);
    },
    onError: (error) => toast.error('Could not create the workflow', errorMessage(error)),
  });

  const isFavorite =
    kind === 'project' &&
    Boolean(projectId) &&
    (favorites.data ?? []).some((f) => f.resourceType === 'project' && f.resourceId === projectId);
  const toggleFavorite = useMutation({
    mutationFn: async () => {
      if (isFavorite) await favoritesApi.remove('project', projectId!);
      else await favoritesApi.add('project', projectId!);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.favorites }),
    onError: (error) => toast.error('Could not change the favorite', errorMessage(error)),
  });

  const allowed = (scope: Scope) => Boolean(target) && can(scope, target);
  const variablesPath = kind === 'project' ? `/projects/${encodeURIComponent(projectId!)}/variables` : null;
  const items: MenuItem[] = [];
  const add = (key: string, label: string, icon: ReactNode, scope: Scope, onSelect: () => void) => {
    if (allowed(scope)) items.push({ key, label, icon, onSelect });
  };
  add('workflow', 'Workflow', <Workflow size={14} />, 'workflow:create', () => createWorkflow.mutate());
  add('credential', 'Credential', <KeyRound size={14} />, 'credential:create', () =>
    setDialog('credentialType'),
  );
  add('folder', 'Folder', <FolderPlus size={14} />, 'folder:create', () => setDialog('folder'));
  add('table', 'Data table', <Table2 size={14} />, 'dataTable:create', () => setDialog('table'));
  if (variablesPath) {
    add('variable', 'Variable', <VariableIcon size={14} />, 'projectVariable:create', () =>
      navigate(variablesPath),
    );
  } else if (kind === 'home' && can('variable:create')) {
    items.push({
      key: 'variable',
      label: 'Variable',
      icon: <VariableIcon size={14} />,
      onSelect: () => navigate('/settings/variables'),
    });
  }

  const row = kind === 'project' ? project.data : undefined;
  const title =
    kind === 'project' ? (row ? (row.type === 'personal' ? 'Personal' : row.name) : '') : TITLES[kind].title;
  const text =
    kind === 'project'
      ? row?.type === 'personal'
        ? 'Workflows and credentials owned by you.'
        : (row?.description ?? '')
      : TITLES[kind].text;

  return (
    <>
      <header className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-6 pt-8 pb-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {row && (
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-3 text-ink-2">
              <ProjectIconView icon={row.icon} type={row.type} size={20} />
            </span>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold">{title}</h1>
            {text && <p className="mt-0.5 truncate text-sm text-ink-2">{text}</p>}
          </div>
        </div>
        {row?.type === 'team' && (
          <Button
            variant="ghost"
            aria-pressed={isFavorite}
            aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            icon={<Star size={15} className={isFavorite ? 'fill-current text-brand' : undefined} />}
            onClick={() => toggleFavorite.mutate()}
          />
        )}
        {items.length > 0 && (
          <Menu
            align="end"
            trigger={(t) => (
              <Button
                variant="primary"
                icon={<Plus size={15} />}
                onClick={t.toggle}
                aria-expanded={t['aria-expanded']}
                aria-haspopup="menu"
                loading={createWorkflow.isPending}
              >
                Create
                <ChevronDown size={14} />
              </Button>
            )}
            items={items}
          />
        )}
      </header>
      <CredentialTypePicker
        open={dialog === 'credentialType'}
        onClose={() => setDialog(null)}
        onPick={(type) => {
          setDialog(null);
          setCredentialType(type);
        }}
      />
      <CredentialModal
        open={credentialType !== null}
        onClose={() => setCredentialType(null)}
        credentialId={null}
        type={credentialType}
      />
      <FolderDialog
        mode="create"
        open={dialog === 'folder'}
        onClose={() => setDialog(null)}
        parentFolderId={null}
      />
      {dialog === 'table' && <CreateTableDialog onClose={() => setDialog(null)} />}
    </>
  );
}
