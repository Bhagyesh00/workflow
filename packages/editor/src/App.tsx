/** Providers and routes. */
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { createBrowserRouter, createHashRouter, Navigate, type RouteObject } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { AppShell } from './components/shell/AppShell';
import { BrandApplier } from './components/shell/BrandMark';
import { ConfirmHost } from './components/ui/Dialog';
import { Toaster } from './components/ui/Toaster';
import { applyTheme } from './lib/brand';
import { AcceptInvitationPage, LoginPage, SignupPage } from './pages/auth/AuthPages';
import { CredentialsPage } from './pages/CredentialsPage';
import { NotFoundPage, RouteErrorPage } from './pages/ErrorPages';
import { ExecutionDetailPage } from './pages/ExecutionDetailPage';
import { ExecutionsPage } from './pages/ExecutionsPage';
import {
  AccountSettingsPage,
  ApiKeysSettingsPage,
  MembersSettingsPage,
  SettingsLayout,
  VariablesSettingsPage,
} from './pages/SettingsPages';
import { WorkflowEditorPage } from './pages/WorkflowEditorPage';
import { WorkflowsPage } from './pages/WorkflowsPage';
import { useUiStore } from './stores/ui-store';

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
      { path: 'workflow/:id', element: <WorkflowEditorPage /> },
      { path: 'executions', element: <ExecutionsPage /> },
      { path: 'executions/:id', element: <ExecutionDetailPage /> },
      { path: 'credentials', element: <CredentialsPage /> },
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

/** `hash` routing is used by the self-contained demo build, which may be served from any path. */
export function App({ queryClient, hash = false }: { queryClient: QueryClient; hash?: boolean }) {
  const [router] = useState(() => (hash ? createHashRouter(routes) : createBrowserRouter(routes)));
  return (
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  );
}
