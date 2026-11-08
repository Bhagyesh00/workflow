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
import { FormSignInPage } from './pages/auth/FormSignInPage';
import { NotFoundPage, RouteErrorPage } from './pages/ErrorPages';
import { ExecutionsPage } from './pages/ExecutionsPage';
import { InboxPage } from './pages/InboxPage';
import { ReviewDetailPage } from './pages/ReviewDetailPage';
import { SecretsSettingsPage } from './pages/SecretsSettingsPage';
import { SecuritySettingsPage } from './pages/SecuritySettingsPage';
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
const DataTablesPage = lazy(() =>
  import('./pages/DataTablesPage').then((m) => ({ default: m.DataTablesPage })),
);
const DataTableDetailPage = lazy(() =>
  import('./pages/DataTableDetailPage').then((m) => ({ default: m.DataTableDetailPage })),
);
// P5-11
const EvaluationsPage = lazy(() =>
  import('./pages/EvaluationsPage').then((m) => ({ default: m.EvaluationsPage })),
);
const EvaluationRunPage = lazy(() =>
  import('./pages/EvaluationRunPage').then((m) => ({ default: m.EvaluationRunPage })),
);
// P5-09, P5-14, P5-15
const AiSettingsPage = lazy(() =>
  import('./pages/AiSettingsPage').then((m) => ({ default: m.AiSettingsPage })),
);
const McpSettingsPage = lazy(() =>
  import('./pages/McpSettingsPage').then((m) => ({ default: m.McpSettingsPage })),
);
const OAuthConsentPage = lazy(() =>
  import('./pages/OAuthConsentPage').then((m) => ({ default: m.OAuthConsentPage })),
);
// P5-67, P5-71
const AssistantPage = lazy(() =>
  import('./pages/AssistantPage').then((m) => ({ default: m.AssistantPage })),
);
const AssistantSettingsPage = lazy(() =>
  import('./pages/AssistantSettingsPage').then((m) => ({ default: m.AssistantSettingsPage })),
);

function Lazy({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageLoader />}>{children}</Suspense>;
}

export const routes: RouteObject[] = [
  { path: '/signin', element: <LoginPage />, errorElement: <RouteErrorPage /> },
  { path: '/signup', element: <SignupPage />, errorElement: <RouteErrorPage /> },
  { path: '/invitation/:token', element: <AcceptInvitationPage />, errorElement: <RouteErrorPage /> },
  // links sent before the server emitted /invitation/:token
  { path: '/invitations/:token', element: <AcceptInvitationPage />, errorElement: <RouteErrorPage /> },
  // P4-16: signed-out visitors of a protected form land here; outside the server's /form/ prefix
  { path: '/form-auth', element: <FormSignInPage />, errorElement: <RouteErrorPage /> },
  // P5-14: an MCP client's OAuth consent; outside the app shell, the page sends a signed-out visitor to /signin
  {
    path: '/oauth/consent',
    element: (
      <Lazy>
        <OAuthConsentPage />
      </Lazy>
    ),
    errorElement: <RouteErrorPage />,
  },
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <Navigate to="/workflows" replace /> },
      { path: 'workflows', element: <WorkflowsPage /> },
      {
        path: 'assistant',
        element: (
          <Lazy>
            <AssistantPage />
          </Lazy>
        ),
      },
      {
        path: 'assistant/:threadId',
        element: (
          <Lazy>
            <AssistantPage />
          </Lazy>
        ),
      },
      {
        path: 'workflow/:id',
        element: (
          <Lazy>
            <WorkflowEditorPage />
          </Lazy>
        ),
      },
      {
        path: 'workflow/:id/evaluations',
        element: (
          <Lazy>
            <EvaluationsPage />
          </Lazy>
        ),
      },
      {
        path: 'workflow/:id/evaluations/:runId',
        element: (
          <Lazy>
            <EvaluationRunPage />
          </Lazy>
        ),
      },
      { path: 'executions', element: <ExecutionsPage /> },
      { path: 'inbox', element: <InboxPage /> },
      { path: 'inbox/:reviewId', element: <ReviewDetailPage /> },
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
        path: 'data-tables',
        element: (
          <Lazy>
            <DataTablesPage />
          </Lazy>
        ),
      },
      {
        path: 'data-tables/:id',
        element: (
          <Lazy>
            <DataTableDetailPage />
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
          { path: 'security', element: <SecuritySettingsPage /> },
          { path: 'external-secrets', element: <SecretsSettingsPage /> },
          {
            path: 'ai',
            element: (
              <Lazy>
                <AiSettingsPage />
              </Lazy>
            ),
          },
          {
            path: 'mcp',
            element: (
              <Lazy>
                <McpSettingsPage />
              </Lazy>
            ),
          },
          {
            path: 'assistant',
            element: (
              <Lazy>
                <AssistantSettingsPage />
              </Lazy>
            ),
          },
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
