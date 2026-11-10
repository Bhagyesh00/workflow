/** Providers and routes. */
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, type ReactNode, Suspense, useEffect, useState } from 'react';
import {
  createBrowserRouter,
  createHashRouter,
  createMemoryRouter,
  Navigate,
  type RouteObject,
  useLocation,
  useParams,
} from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { ProjectDialogsHost } from './components/projects/ProjectDialogsHost';
import { ProjectVariablesTab } from './components/projects/ProjectVariablesTab';
import { AppShell } from './components/shell/AppShell';
import { BrandApplier } from './components/shell/BrandMark';
import { ConfirmHost } from './components/ui/Dialog';
import { PageLoader } from './components/ui/misc';
import { Toaster } from './components/ui/Toaster';
import { applyTheme } from './lib/brand';
import { AcceptInvitationPage, LoginPage, SignupPage } from './pages/auth/AuthPages';
import { ConfirmEmailChangePage } from './pages/auth/ConfirmEmailChangePage';
import { CredentialConnectPage } from './pages/auth/CredentialConnectPage';
import { ForgotPasswordPage } from './pages/auth/ForgotPasswordPage';
import { FormSignInPage } from './pages/auth/FormSignInPage';
import { ResetPasswordPage } from './pages/auth/ResetPasswordPage';
import { NotFoundPage, RouteErrorPage } from './pages/ErrorPages';
import { InboxPage } from './pages/InboxPage';
import { LdapSettingsPage } from './pages/LdapSettingsPage';
import {
  ProjectLayout,
  type ProjectPageKind,
  type ProjectResource,
  ProjectResourcePage,
} from './pages/ProjectPages';
import { ProjectSettingsPage } from './pages/ProjectSettingsPage';
import { ReviewDetailPage } from './pages/ReviewDetailPage';
import { RoleEditorPage, type RoleKind, RolesPage } from './pages/RolesPages';
import { ScimSettingsPage } from './pages/ScimSettingsPage';
import { SecretsSettingsPage } from './pages/SecretsSettingsPage';
import { SecuritySettingsPage } from './pages/SecuritySettingsPage';
import {
  AccountSettingsPage,
  ApiKeysSettingsPage,
  MembersSettingsPage,
  SettingsLayout,
  VariablesSettingsPage,
} from './pages/SettingsPages';
import { AuthenticationSettingsPage } from './pages/sso/AuthenticationSettingsPage';
import { RoleProvisioningPanel } from './pages/sso/RoleProvisioningPanel';
import { SamlOnboardingPage } from './pages/sso/SamlOnboardingPage';
import { SsoSettingsPage } from './pages/sso/SsoSettingsPage';
import { useUiStore } from './stores/ui-store';

// the canvas, node details view and code editors load on demand
const WorkflowEditorPage = lazy(() =>
  import('./pages/WorkflowEditorPage').then((m) => ({ default: m.WorkflowEditorPage })),
);
const ExecutionDetailPage = lazy(() =>
  import('./pages/ExecutionDetailPage').then((m) => ({ default: m.ExecutionDetailPage })),
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
const AssistantPage = lazy(() => import('./pages/AssistantPage').then((m) => ({ default: m.AssistantPage })));
const AssistantSettingsPage = lazy(() =>
  import('./pages/AssistantSettingsPage').then((m) => ({ default: m.AssistantSettingsPage })),
);

function Lazy({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageLoader />}>{children}</Suspense>;
}

/** P6-41: an old list path goes to its `/home/*` page and keeps the query string (`?folder=`, filters) */
function RedirectKeepingQuery({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: to, search, hash }} replace />;
}

/** renders `children` with a route param (`:id`, `:slug`) */
function WithParam({ name, children }: { name: string; children: (value: string) => ReactNode }) {
  const value = useParams()[name];
  return value ? children(value) : <NotFoundPage />;
}

/** the list tabs of one page family (`/home`, `/shared`, `/projects/:id`) */
function resourceRoutes(kind: ProjectPageKind, resources: ProjectResource[]): RouteObject[] {
  const page = (resource: ProjectResource) =>
    kind === 'project' ? (
      <WithParam name="id">
        {(id) => <ProjectResourcePage kind={kind} resource={resource} projectId={id} />}
      </WithParam>
    ) : (
      <ProjectResourcePage kind={kind} resource={resource} />
    );
  return [
    { index: true, element: <Navigate to="workflows" replace /> },
    ...resources.map((resource) => ({ path: resource, element: page(resource) })),
  ];
}

/** P6-46: the role editor routes of one role type */
function roleEditorRoutes(roleType: RoleKind): RouteObject[] {
  return [
    { path: 'new', element: <RoleEditorPage roleType={roleType} mode="new" /> },
    {
      path: 'edit/:slug',
      element: (
        <WithParam name="slug">
          {(slug) => <RoleEditorPage roleType={roleType} mode="edit" slug={slug} />}
        </WithParam>
      ),
    },
    {
      path: 'view/:slug',
      element: (
        <WithParam name="slug">
          {(slug) => <RoleEditorPage roleType={roleType} mode="view" slug={slug} />}
        </WithParam>
      ),
    },
  ];
}

/** the signed-in layout plus the Share and Move dialogs, mounted once (P6-44) */
function ShellRoot() {
  return (
    <>
      <AppShell />
      <ProjectDialogsHost />
    </>
  );
}

export const routes: RouteObject[] = [
  { path: '/signin', element: <LoginPage />, errorElement: <RouteErrorPage /> },
  { path: '/signup', element: <SignupPage />, errorElement: <RouteErrorPage /> },
  // P6-19: password reset and email change; the token is read from the query once, then sent in a body
  { path: '/forgot-password', element: <ForgotPasswordPage />, errorElement: <RouteErrorPage /> },
  { path: '/reset-password', element: <ResetPasswordPage />, errorElement: <RouteErrorPage /> },
  { path: '/confirm-email-change', element: <ConfirmEmailChangePage />, errorElement: <RouteErrorPage /> },
  // P6-13: after a SAML sign-in that carried no name
  { path: '/saml/onboarding', element: <SamlOnboardingPage />, errorElement: <RouteErrorPage /> },
  // P6-87: connect or disconnect your own account on a private credential, then back to the form or chat
  { path: '/credential-connect/:id', element: <CredentialConnectPage />, errorElement: <RouteErrorPage /> },
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
    element: <ShellRoot />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <Navigate to="/home/workflows" replace /> },
      // P6-41: Overview, Shared with you and the project pages
      {
        path: 'home',
        element: <ProjectLayout kind="home" />,
        children: resourceRoutes('home', ['workflows', 'credentials', 'executions', 'data-tables']),
      },
      {
        path: 'shared',
        element: <ProjectLayout kind="shared" />,
        children: resourceRoutes('shared', ['workflows', 'credentials']),
      },
      {
        path: 'projects/:id',
        element: <WithParam name="id">{(id) => <ProjectLayout kind="project" projectId={id} />}</WithParam>,
        children: [
          ...resourceRoutes('project', ['workflows', 'credentials', 'executions', 'data-tables', 'folders']),
          {
            path: 'variables',
            element: <WithParam name="id">{(id) => <ProjectVariablesTab projectId={id} />}</WithParam>,
          },
          {
            path: 'settings',
            element: <WithParam name="id">{(id) => <ProjectSettingsPage projectId={id} />}</WithParam>,
          },
        ],
      },
      // the old list paths (links, bookmarks, `safeRedirect`'s default `/workflows`)
      { path: 'workflows', element: <RedirectKeepingQuery to="/home/workflows" /> },
      { path: 'executions', element: <RedirectKeepingQuery to="/home/executions" /> },
      { path: 'credentials', element: <RedirectKeepingQuery to="/home/credentials" /> },
      { path: 'data-tables', element: <RedirectKeepingQuery to="/home/data-tables" /> },
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
          // P6-46: roles (`role:manage`) and the role editors
          { path: 'roles', element: <RolesPage /> },
          { path: 'project-roles', children: roleEditorRoutes('project') },
          { path: 'instance-roles', children: roleEditorRoutes('global') },
          { path: 'api-keys', element: <ApiKeysSettingsPage /> },
          { path: 'variables', element: <VariablesSettingsPage /> },
          { path: 'security', element: <SecuritySettingsPage /> },
          // P6-13: the hub and its pages (each gates itself by scope)
          { path: 'authentication', element: <AuthenticationSettingsPage /> },
          { path: 'sso', element: <SsoSettingsPage /> },
          { path: 'ldap', element: <LdapSettingsPage /> },
          { path: 'provisioning', element: <RoleProvisioningPanel /> },
          { path: 'scim', element: <ScimSettingsPage /> },
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
  if (mode === 'memory') return createMemoryRouter(routes, { initialEntries: ['/home/workflows'] });
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
