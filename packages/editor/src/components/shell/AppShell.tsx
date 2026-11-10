/** Signed-in layout: sidebar with brand, workspace switcher and navigation; pages render on the right. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronsUpDown,
  Inbox,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sparkles,
  Sun,
} from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import {
  errorMessage,
  isApiError,
  onMfaEnrollmentRequired,
  onTenantChanged,
  onUnauthorized,
  setCurrentTenant,
} from '../../api/client';
import { authApi } from '../../api/endpoints';
import { assistantFeatureOf, queryKeys, useMe, useSettings } from '../../api/queries';
import type { Me } from '../../api/types';
import { CommandBar } from '../../features/command-bar/CommandBar';
import { InboxNavBadge } from '../../features/reviews/InboxNavBadge';
import { assistantLinkVisible } from '../../lib/assistant-access';
import { toast, useUiStore } from '../../stores/ui-store';
import { DataTableStorageBanner } from '../data-tables/StorageBanner';
import { ProjectNav } from '../projects/ProjectNav';
import { Button } from '../ui/Button';
import { cx } from '../ui/cx';
import { Menu } from '../ui/Menu';
import { EmptyState, PageLoader } from '../ui/misc';
import { BrandMark } from './BrandMark';
import { FavoritesNav } from './FavoritesNav';
import { PushBridge } from './PushBridge';

const NARROW = '(max-width: 900px)';

/** Narrow screens get the icon rail so content keeps its width. */
function useNarrowScreen(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia?.(NARROW);
      media?.addEventListener?.('change', onChange);
      return () => media?.removeEventListener?.('change', onChange);
    },
    () => Boolean(window.matchMedia?.(NARROW).matches),
    () => false,
  );
}

// P6-41: Workflows, Executions, Credentials and Data tables are tabs of the project pages (ProjectTabs)
const NAV = [
  // P5-67: shown while the Assistant is on, to members once a model is set (lib/assistant-access.ts)
  { to: '/assistant', label: 'Assistant', icon: Sparkles },
  // P3-19: shown while workflow reviews are on for the workspace
  { to: '/inbox', label: 'Inbox', icon: Inbox },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function TenantSwitcher({ me, collapsed }: { me: Me; collapsed: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const switchTenant = useMutation({
    mutationFn: authApi.switchTenant,
    onSuccess: async (result) => {
      setCurrentTenant(result.tenant.id);
      queryClient.clear();
      queryClient.setQueryData(queryKeys.me, { ...me, ...result });
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
      navigate('/home/workflows');
      toast.success(`Switched to ${result.tenant.name}`);
    },
    onError: (error) => toast.error('Could not switch workspace', errorMessage(error)),
  });
  const others = me.tenants.filter((t) => t.id !== me.tenant.id);
  return (
    <Menu
      align="start"
      className="w-full"
      trigger={(t) => (
        <button
          type="button"
          onClick={t.toggle}
          aria-expanded={t['aria-expanded']}
          aria-haspopup="menu"
          title={collapsed ? me.tenant.name : undefined}
          className={cx(
            'flex w-full items-center gap-2 rounded-xl border border-line bg-surface-2 text-left hover:border-line-strong',
            collapsed ? 'justify-center p-1.5' : 'px-2.5 py-2',
          )}
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-3 font-display text-xs font-bold text-ink-2">
            {me.tenant.name.charAt(0).toUpperCase()}
          </span>
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-ink">{me.tenant.name}</span>
                <span className="block truncate text-2xs text-ink-3 capitalize">{me.role}</span>
              </span>
              <ChevronsUpDown size={14} className="text-ink-3" />
            </>
          )}
        </button>
      )}
      header={<p className="px-2.5 pt-1.5 pb-1 text-2xs font-semibold text-ink-3">Workspaces</p>}
      items={[
        {
          key: me.tenant.id,
          label: me.tenant.name,
          icon: <Check size={13} className="text-brand" />,
          hint: me.role,
          onSelect: () => undefined,
        },
        ...others.map((t) => ({
          key: t.id,
          label: t.name,
          icon: <span className="inline-block size-[13px]" />,
          hint: t.role,
          onSelect: () => switchTenant.mutate(t.id),
        })),
      ]}
    />
  );
}

function UserMenu({ me, collapsed }: { me: Me; collapsed: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const logout = async () => {
    try {
      await authApi.logout();
    } catch {
      // the session may already be gone
    }
    setCurrentTenant(null);
    queryClient.clear();
    navigate('/signin');
  };
  return (
    <Menu
      align="start"
      placement="top"
      className="w-full"
      trigger={(t) => (
        <button
          type="button"
          onClick={t.toggle}
          aria-expanded={t['aria-expanded']}
          aria-haspopup="menu"
          className={cx(
            'flex w-full items-center gap-2.5 rounded-xl text-left hover:bg-surface-3',
            collapsed ? 'justify-center p-1.5' : 'px-2 py-1.5',
          )}
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft font-semibold text-brand">
            {(me.user.name || me.user.email).charAt(0).toUpperCase()}
          </span>
          {!collapsed && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{me.user.name || me.user.email}</span>
              <span className="block truncate text-2xs text-ink-3">{me.user.email}</span>
            </span>
          )}
        </button>
      )}
      items={[
        {
          key: 'light',
          label: 'Light theme',
          icon: <Sun size={14} />,
          hint: theme === 'light' ? <Check size={13} /> : null,
          onSelect: () => setTheme('light'),
        },
        {
          key: 'dark',
          label: 'Dark theme',
          icon: <Moon size={14} />,
          hint: theme === 'dark' ? <Check size={13} /> : null,
          onSelect: () => setTheme('dark'),
        },
        {
          key: 'system',
          label: 'Match system',
          icon: <Monitor size={14} />,
          hint: theme === 'system' ? <Check size={13} /> : null,
          onSelect: () => setTheme('system'),
        },
        'separator',
        {
          key: 'account',
          label: 'Your account',
          icon: <Settings size={14} />,
          onSelect: () => navigate('/settings/account'),
        },
        { key: 'logout', label: 'Sign out', icon: <LogOut size={14} />, onSelect: () => void logout() },
      ]}
    />
  );
}

export function AppShell() {
  const me = useMe();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const collapsedPref = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const inEditor =
    location.pathname.startsWith('/workflow/') || /^\/executions\/[^/]+/.test(location.pathname);
  const narrow = useNarrowScreen();
  const collapsed = collapsedPref || inEditor || narrow;
  const settings = useSettings();
  const reviewsEnabled = settings.workflowReviews?.enabled === true;
  const assistantVisible = assistantLinkVisible(assistantFeatureOf(settings), me.data);

  useEffect(
    () =>
      onUnauthorized(() => {
        setCurrentTenant(null);
        queryClient.removeQueries({ queryKey: queryKeys.me });
        navigate(`/signin?redirect=${encodeURIComponent(location.pathname + location.search)}`);
      }),
    [navigate, location.pathname, location.search, queryClient],
  );

  // P6-18: the workspace enforces two-step sign-in and this user has none: keep the session and open
  // the setup on the account page (MfaSection opens its dialog on `?mfa=setup`), not the sign-in page
  useEffect(
    () => onMfaEnrollmentRequired(() => navigate('/settings/account?mfa=setup', { replace: true })),
    [navigate],
  );

  // another tab switched the session's workspace: follow it instead of writing into it blindly
  useEffect(() => {
    let reloading = false;
    return onTenantChanged(() => {
      if (reloading) return;
      reloading = true;
      void (async () => {
        try {
          // /auth/me names the workspace the session uses now (and rebinds this tab to it)
          await queryClient.refetchQueries({ queryKey: queryKeys.me, exact: true });
          navigate('/home/workflows');
          await queryClient.resetQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.me[0] });
          const next = queryClient.getQueryData<Me>(queryKeys.me);
          toast.info(
            'Workspace switched in another tab',
            next ? `This tab now shows ${next.tenant.name}.` : undefined,
          );
        } finally {
          reloading = false;
        }
      })();
    });
  }, [navigate, queryClient]);

  if (me.isLoading) return <PageLoader label="Loading your workspace" />;
  if (me.error) {
    if (isApiError(me.error, 401)) {
      return (
        <Navigate
          to={`/signin?redirect=${encodeURIComponent(location.pathname + location.search)}`}
          replace
        />
      );
    }
    return (
      <EmptyState
        className="h-full"
        title="Could not reach the server"
        description={errorMessage(me.error)}
        action={<Button onClick={() => void me.refetch()}>Try again</Button>}
      />
    );
  }
  const data = me.data!;
  return (
    <div className="flex h-full">
      <PushBridge tenantId={data.tenant.id} />
      <CommandBar />
      <nav
        aria-label="Main"
        className={cx(
          'flex shrink-0 flex-col gap-3 border-r border-line bg-surface py-3 transition-[width]',
          collapsed ? 'w-[60px] px-2' : 'w-60 px-3',
        )}
      >
        <div className={cx('flex items-center', collapsed ? 'justify-center' : 'justify-between px-1')}>
          <BrandMark withName={!collapsed} size={collapsed ? 30 : 32} />
          {!collapsed && (
            <button
              type="button"
              aria-label="Collapse sidebar"
              onClick={() => toggleSidebar(true)}
              className="grid size-7 place-items-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink"
            >
              <PanelLeftClose size={15} />
            </button>
          )}
        </div>
        <ProjectNav collapsed={collapsed} />
        <TenantSwitcher me={data} collapsed={collapsed} />
        <ul className="flex flex-col gap-0.5">
          {NAV.filter(
            (item) =>
              (item.to !== '/inbox' || reviewsEnabled) && (item.to !== '/assistant' || assistantVisible),
          ).map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                title={collapsed ? label : undefined}
                className={({ isActive }) =>
                  cx(
                    'flex items-center gap-2.5 rounded-lg text-sm font-semibold transition-colors',
                    collapsed ? 'justify-center p-2' : 'px-2.5 py-2',
                    isActive ? 'bg-brand-soft text-brand' : 'text-ink-2 hover:bg-surface-3 hover:text-ink',
                  )
                }
              >
                <Icon size={17} />
                {!collapsed && label}
                {to === '/inbox' && <InboxNavBadge collapsed={collapsed} />}
              </NavLink>
            </li>
          ))}
        </ul>
        <FavoritesNav collapsed={collapsed} />
        <div className="mt-auto flex flex-col gap-2">
          {collapsedPref && !inEditor && !narrow && (
            <button
              type="button"
              aria-label="Expand sidebar"
              onClick={() => toggleSidebar(false)}
              className="grid size-9 place-items-center self-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink"
            >
              <PanelLeftOpen size={16} />
            </button>
          )}
          <UserMenu me={data} collapsed={collapsed} />
        </div>
      </nav>
      <main className="min-w-0 flex-1 overflow-auto">
        <DataTableStorageBanner />
        <Outlet />
      </main>
    </div>
  );
}
