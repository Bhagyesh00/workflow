/** P6-45: the members page's View projects: the projects a member belongs to, with the role in each. */
import { useQueries, useQuery } from '@tanstack/react-query';
import { errorMessage } from '../../api/client';
import { projectsApi } from '../../api/endpoints';
import { queryKeys, useRoles } from '../../api/queries';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Callout, PageLoader } from '../ui/misc';

export interface ViewProjectsModalProps {
  userId: string;
  onClose(): void;
}

export function ViewProjectsModal({ userId, onClose }: ViewProjectsModalProps) {
  const list = useQuery({ queryKey: [...queryKeys.projects, 'every'], queryFn: projectsApi.list });
  const roles = useRoles();
  // the member rows of each project carry the role; one detail per project (the list rows have none)
  const details = useQueries({
    queries: (list.data ?? []).map((p) => ({
      queryKey: queryKeys.project(p.id),
      queryFn: () => projectsApi.get(p.id),
      retry: false,
    })),
  });
  const roleName = (slug: string) =>
    [...(roles.data?.project ?? []), ...(roles.data?.global ?? [])].find((r) => r.slug === slug)
      ?.displayName ?? slug;
  const rows = details.flatMap((d) => {
    const project = d.data;
    if (!project) return [];
    const relation = project.relations.find((r) => r.id === userId);
    if (relation) return [{ project, role: roleName(relation.role), implicit: false }];
    const implicit = project.implicitMembers.find((m) => m.id === userId);
    return implicit ? [{ project, role: implicit.globalRole.displayName, implicit: true }] : [];
  });
  const loading = list.isLoading || details.some((d) => d.isLoading);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Projects"
      size="md"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {loading ? (
        <PageLoader />
      ) : list.error ? (
        <Callout tone="err">{errorMessage(list.error)}</Callout>
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-2">This member is not in any project.</p>
      ) : (
        <ul aria-label="Projects of the member" className="flex flex-col">
          {rows.map(({ project, role, implicit }) => (
            <li
              key={project.id}
              className="flex items-center gap-3 border-b border-line py-2.5 last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate font-semibold">
                {project.type === 'personal' ? 'Personal space' : project.name}
              </span>
              <span className="text-sm text-ink-2">{role}</span>
              {implicit && <span className="text-xs text-ink-3">through the workspace role</span>}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
