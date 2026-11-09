/**
 * P6-41: the sidebar's project block, under the logo: Overview, Shared with you, Personal, the Projects
 * list with Add project, and favorite projects. A user sees only their projects (`useProjects`).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Briefcase,
  Folder,
  Home,
  Layers,
  type LucideIcon,
  Plus,
  Rocket,
  Share2,
  Star,
  User,
  Users,
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router';
import { errorMessage } from '../../api/client';
import { projectsApi } from '../../api/endpoints';
import { queryKeys, useFavorites, useProjects } from '../../api/queries';
import type { Project, ProjectIcon, ProjectType } from '../../api/types';
import { usePermissions } from '../../lib/permissions';
import { toast } from '../../stores/ui-store';
import { cx } from '../ui/cx';

export interface ProjectNavProps {
  /** the icon rail: icons only */
  collapsed: boolean;
}

const ICONS: Record<string, LucideIcon> = {
  layers: Layers,
  folder: Folder,
  briefcase: Briefcase,
  home: Home,
  rocket: Rocket,
  star: Star,
  users: Users,
  user: User,
};

/** a project's icon: its emoji, its named icon, or the default for its type */
export function ProjectIconView({
  icon,
  type,
  size = 15,
  className,
}: {
  icon: ProjectIcon | null | undefined;
  type: ProjectType;
  size?: number;
  className?: string;
}) {
  if (icon?.type === 'emoji') {
    return (
      <span
        aria-hidden="true"
        className={cx('shrink-0 leading-none', className)}
        style={{ fontSize: size, color: icon.color }}
      >
        {icon.value}
      </span>
    );
  }
  const Icon =
    (icon?.type === 'icon' ? ICONS[icon.value] : undefined) ?? (type === 'personal' ? User : Layers);
  return (
    <Icon
      size={size}
      aria-hidden="true"
      className={cx('shrink-0', className)}
      style={icon?.color ? { color: icon.color } : undefined}
    />
  );
}

const linkClass = (collapsed: boolean, active: boolean) =>
  cx(
    'flex items-center gap-2.5 rounded-lg text-sm font-semibold transition-colors',
    collapsed ? 'justify-center p-2' : 'px-2.5 py-2',
    active ? 'bg-brand-soft text-brand' : 'text-ink-2 hover:bg-surface-3 hover:text-ink',
  );

/** a project's page, on its Workflows tab */
export const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}/workflows`;

export function ProjectNav({ collapsed }: ProjectNavProps) {
  const projects = useProjects();
  const favorites = useFavorites();
  const { can } = usePermissions();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const path = location.pathname;

  const add = useMutation({
    mutationFn: () => projectsApi.create({ name: 'My project' }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      navigate(`/projects/${encodeURIComponent(project.id)}/settings`);
    },
    onError: (error) => toast.error('Could not create the project', errorMessage(error)),
  });

  const rows: Project[] = projects.data ?? [];
  const personal = rows.find((p) => p.type === 'personal');
  const team = rows.filter((p) => p.type === 'team');
  const favoriteIds = new Set(
    (favorites.data ?? []).filter((f) => f.resourceType === 'project').map((f) => f.resourceId),
  );
  const favoriteProjects = team.filter((p) => favoriteIds.has(p.id));
  const inProject = (id: string) => {
    const base = `/projects/${encodeURIComponent(id)}`;
    return path === base || path.startsWith(`${base}/`);
  };

  const fixed = [
    {
      key: 'overview',
      to: '/home/workflows',
      label: 'Overview',
      icon: Home,
      active: path === '/home' || path.startsWith('/home/'),
    },
    {
      key: 'shared',
      to: '/shared/workflows',
      label: 'Shared with you',
      icon: Share2,
      active: path === '/shared' || path.startsWith('/shared/'),
    },
    ...(personal
      ? [
          {
            key: 'personal',
            to: projectPath(personal.id),
            label: 'Personal',
            icon: User,
            active: inProject(personal.id),
          },
        ]
      : []),
  ];

  const addButton = (
    <button
      type="button"
      aria-label="Add project"
      title="Add project"
      disabled={add.isPending}
      onClick={() => add.mutate()}
      className={cx(
        'grid place-items-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink disabled:opacity-50',
        collapsed ? 'mx-auto size-8' : 'size-6',
      )}
    >
      <Plus size={collapsed ? 15 : 14} />
    </button>
  );

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-0.5">
        {fixed.map(({ key, to, label, icon: Icon, active }) => (
          <li key={key}>
            <Link
              to={to}
              title={collapsed ? label : undefined}
              aria-label={collapsed ? label : undefined}
              aria-current={active ? 'page' : undefined}
              className={linkClass(collapsed, active)}
            >
              <Icon size={17} aria-hidden="true" />
              {!collapsed && label}
            </Link>
          </li>
        ))}
      </ul>
      {favoriteProjects.length > 0 && !collapsed && (
        <nav aria-label="Favorite projects" className="flex flex-col gap-0.5">
          <h2 className="flex items-center gap-1.5 px-2.5 pb-1 text-2xs font-semibold tracking-wide text-ink-3 uppercase">
            <Star size={11} aria-hidden="true" /> Favorite projects
          </h2>
          <ul className="flex flex-col gap-0.5">
            {favoriteProjects.map((p) => (
              <li key={p.id}>
                <Link
                  to={projectPath(p.id)}
                  className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-ink-2 hover:bg-surface-3 hover:text-ink"
                >
                  <ProjectIconView icon={p.icon} type={p.type} />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <nav aria-label="Projects" className="flex flex-col gap-0.5">
        {collapsed ? (
          can('project:create') && addButton
        ) : (
          <div className="flex items-center justify-between px-2.5 pb-1">
            <h2 className="text-2xs font-semibold tracking-wide text-ink-3 uppercase">Projects</h2>
            {can('project:create') && addButton}
          </div>
        )}
        <ul className="flex flex-col gap-0.5">
          {team.map((p) => (
            <li key={p.id}>
              <Link
                to={projectPath(p.id)}
                title={collapsed ? p.name : undefined}
                aria-label={collapsed ? p.name : undefined}
                aria-current={inProject(p.id) ? 'page' : undefined}
                className={linkClass(collapsed, inProject(p.id))}
              >
                <ProjectIconView icon={p.icon} type={p.type} size={16} />
                {!collapsed && <span className="min-w-0 flex-1 truncate">{p.name}</span>}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
