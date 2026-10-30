/** Providers and routes. */
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState } from 'react';
import {
  createBrowserRouter,
  createHashRouter,
  createMemoryRouter,
  Navigate,
  type RouteObject,
} from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { AppShell } from './components/shell/AppShell';
import { BrandApplier } from './components/shell/BrandMark';
import { ConfirmHost } from './components/ui/Dialog';
import { PageLoader } from './components/ui/misc';
import { Toaster } from './components/ui/Toaster';
import { applyTheme } from './lib/brand';
import { AcceptInvitationPage, LoginPage, SignupPage } from './pages/auth/AuthPages';
import { NotFoundPage, RouteErrorPage } from './pages/ErrorPages';
import { ExecutionsPage } from './pages/ExecutionsPage';
import {
  AccountSettingsPage,
  ApiKeysSettingsPage,
  MembersSettingsPage,
  SettingsLayout,
  VariablesSettingsPage,
} from './pages/SettingsPages';
import { WorkflowsPage } from './pages/WorkflowsPage';
import { useUiStore } from './stores/ui-store';

// the canvas, node details view and code editors load on demand
const WorkflowEditorPage = lazy(() =>
  import('./pages/WorkflowEditorPage').then((m) => ({ default: m.WorkflowEditorPage })),
);
const ExecutionDetailPage = lazy(() =>
  import('./pages/ExecutionDetailPage').then((m) => ({ default: m.ExecutionDetailPage })),
);
const CredentialsPage = lazy(() =>
  import('./pages/CredentialsPage').then((m) => ({ default: m.CredentialsPage })),
);

function Lazy({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageLoader />}>{children}</Suspense>;
}

export const routes: RouteObject[] = [
  { path: '/signin', element: <LoginPage />, errorElement: <RouteErrorPage /> },
  { path: '/signup', element: <SignupPage />, errorElement: <RouteErrorPage /> },
  { path: '/invitation/:token', element: <AcceptInvitationPage />, errorElement: <RouteErrorPage /> },
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <Navigate to="/workflows" replace /> },
      { path: 'workflows', element: <WorkflowsPage /> },
      {
        path: 'workflow/:id',
        element: (
          <Lazy>
            <WorkflowEditorPage />
          </Lazy>
        ),
      },
      { path: 'executions', element: <ExecutionsPage /> },
      {
        path: 'executions/:id',
        element: (
          <Lazy>
            <ExecutionDetailPage />
          </Lazy>
        ),
      },
      {
        path: 'credentials',
        element: (
          <Lazy>
            <CredentialsPage />
          </Lazy>
        ),
      },
      {
        path: 'settings',
        element: <SettingsLayout />,
        children: [
          { index: true, element: <Navigate to="/settings/account" replace /> },
          { path: 'account', element: <AccountSettingsPage /> },
          { path: 'members', element: <MembersSettingsPage /> },
          { path: 'api-keys', element: <ApiKeysSettingsPage /> },
          { path: 'variables', element: <VariablesSettingsPage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

/** Theme follows the stored preference, and the OS when set to "system". */
function ThemeSync() {
  const theme = useUiStore((s) => s.theme);
  useEffect(() => {
    useUiStore.setState({ resolvedTheme: applyTheme(theme) });
    if (theme !== 'system' || !window.matchMedia) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => useUiStore.setState({ resolvedTheme: applyTheme('system') });
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, [theme]);
  return null;
}

export function AppProviders({
  queryClient,
  children,
}: {
  queryClient: QueryClient;
  children: React.ReactNode;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeSync />
      <BrandApplier />
      {children}
      <Toaster />
      <ConfirmHost />
    </QueryClientProvider>
  );
}

export type RouterMode = 'browser' | 'hash' | 'memory';

function createRouter(mode: RouterMode) {
  if (mode === 'hash') return createHashRouter(routes);
  if (mode === 'memory') return createMemoryRouter(routes, { initialEntries: ['/workflows'] });
  return createBrowserRouter(routes);
}

/**
 * The server-backed app uses browser history. The self-contained demo build may be embedded or
 * served from any path, so it keeps its location in memory (or the hash) instead.
 */
export function App({
  queryClient,
  router: mode = 'browser',
}: {
  queryClient: QueryClient;
  router?: RouterMode;
}) {
  const [router] = useState(() => createRouter(mode));
  return (
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  );
}
