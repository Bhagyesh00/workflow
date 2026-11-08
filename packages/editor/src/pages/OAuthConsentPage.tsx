/**
 * P5-14, P5-15: `/oauth/consent?flow=...`: a signed-in user approves or denies an MCP client's access to the
 * workspace. Signed out, the visitor goes to `/signin?redirect=...` and comes back. The page shows the client,
 * the host the browser returns to, the workspace and a picker of what the client may do. The server answers
 * Approve and Deny with the address to go to; the page leaves only for an address that passes the rule of
 * the client registration (no `javascript:`, `data:`, `vbscript:`, `file:`, no fragment) and names the host
 * it showed.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { errorMessage, isApiError } from '../api/client';
import { consentApi } from '../api/endpoints';
import { useMe } from '../api/queries';
import type { McpConsentDetails, McpConsentResult } from '../api/types';
import { redirectUriProblem } from '../components/settings/McpRedirectUris';
import { BrandMark } from '../components/shell/BrandMark';
import { Button } from '../components/ui/Button';
import { Checkbox } from '../components/ui/Field';
import { Callout, PageLoader } from '../components/ui/misc';

/** what each scope lets the client do */
const SCOPE_TEXTS: Record<string, { label: string; allows: string }> = {
  'workflow:read': { label: 'Read workflows', allows: 'Find workflows and read their nodes and settings' },
  'workflow:write': { label: 'Change workflows', allows: 'Create, edit, archive and restore workflows' },
  'workflow:execute': { label: 'Run workflows', allows: 'Start workflows that are available to MCP and read the result' },
  'execution:read': { label: 'Read executions', allows: 'See past runs and what they returned' },
  'credential:read': { label: 'List credentials', allows: 'See the name and type of credentials, never their secrets' },
  'tag:read': { label: 'Read tags', allows: 'List tags' },
  'dataTable:read': { label: 'Read data tables', allows: 'List data tables and read their rows' },
  'dataTable:write': { label: 'Change data tables', allows: 'Create tables and add, change or delete rows' },
  'project:read': { label: 'Read folders', allows: 'List folders' },
  'project:write': { label: 'Change folders', allows: 'Create, rename and delete folders' },
};

/** the way the page leaves for the client; a test replaces `go` */
export const consentNavigation = {
  go(url: string): void {
    window.location.assign(url);
  },
};

/**
 * why the page will not follow `url`, or null when it may: the registration rule without its length limit (the
 * reply adds `code`, `state` and `iss` to the registered URI), and the host shown to the user
 */
export function consentRedirectProblem(url: string, expectedHost: string): string | null {
  const problem = redirectUriProblem(url, { checkLength: false });
  if (problem) return problem;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return 'The address is not a valid URL';
  }
  return host === expectedHost ? null : 'The address does not go back to the host shown above';
}

function CenteredCard({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <BrandMark />
        {children}
      </div>
    </main>
  );
}

export function OAuthConsentPage() {
  const [params] = useSearchParams();
  const flow = params.get('flow') ?? '';
  const me = useMe();
  const signedIn = Boolean(me.data);
  const details = useQuery({
    queryKey: ['mcp', 'consent', flow],
    queryFn: () => consentApi.details(flow),
    enabled: signedIn && flow !== '',
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  // the user's picks belong to the details they were made on: new details start from all their scopes
  const [picked, setPicked] = useState<{ of: McpConsentDetails; scopes: string[] } | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const scopes = (picked && picked.of === details.data ? picked.scopes : details.data?.scopes) ?? [];

  const decide = useMutation({
    mutationFn: (approved: boolean) =>
      consentApi.approve(approved ? { flow, approved, scopes } : { flow, approved }),
    onSuccess: (result: McpConsentResult) => {
      const url = typeof result?.redirectUrl === 'string' ? result.redirectUrl : '';
      const problem = consentRedirectProblem(url, details.data?.redirectHost ?? '');
      if (problem) {
        setBlocked(problem);
        return;
      }
      setLeaving(new URL(url).host);
      consentNavigation.go(url);
    },
  });

  if (me.isLoading) {
    return (
      <CenteredCard>
        <PageLoader />
      </CenteredCard>
    );
  }
  if (me.isError) {
    if (isApiError(me.error, 401)) {
      const back = `/oauth/consent?flow=${encodeURIComponent(flow)}`;
      return <Navigate to={`/signin?redirect=${encodeURIComponent(back)}`} replace />;
    }
    return (
      <CenteredCard>
        <Callout tone="err" title="Couldn't check your sign-in">
          {errorMessage(me.error)}
        </Callout>
      </CenteredCard>
    );
  }
  if (!flow || details.isError) {
    return (
      <CenteredCard>
        <Callout tone="err" title="Couldn't load this request">
          {flow
            ? errorMessage(details.error)
            : 'This link has no request in it. Start again from your MCP client.'}
        </Callout>
      </CenteredCard>
    );
  }
  if (!details.data) {
    return (
      <CenteredCard>
        <PageLoader />
      </CenteredCard>
    );
  }

  const info = details.data;
  if (leaving) {
    return (
      <CenteredCard>
        <p role="status" className="text-sm text-ink-2">
          Returning to {leaving}. You can close this tab if nothing happens.
        </p>
      </CenteredCard>
    );
  }
  const working = decide.isPending;
  const toggleScope = (scope: string, on: boolean) =>
    setPicked({
      of: info,
      scopes: on
        ? info.scopes.filter((s) => s === scope || scopes.includes(s))
        : scopes.filter((s) => s !== scope),
    });

  return (
    <CenteredCard>
      <div>
        <h1 className="font-display text-lg font-semibold">
          <span data-testid="consent-client">{info.clientName}</span> wants to connect
        </h1>
        <p className="mt-1 text-sm text-ink-2">
          to the workspace <strong>{info.tenantName}</strong>. You are signed in as {me.data?.user.email}.
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-ink-3">Returns to</dt>
        <dd className="break-all font-mono text-xs" data-testid="consent-host">
          {info.redirectHost}
        </dd>
        <dt className="text-ink-3">Server</dt>
        <dd className="break-all font-mono text-xs">{info.resource}</dd>
      </dl>
      <fieldset className="flex flex-col gap-2 rounded-xl border border-line p-3">
        <legend className="px-1 text-sm font-semibold">Allow this client to</legend>
        {info.scopes.map((scope) => {
          const text = SCOPE_TEXTS[scope];
          return (
            <div key={scope} className="flex flex-col">
              <Checkbox
                label={text?.label ?? scope}
                checked={scopes.includes(scope)}
                disabled={working}
                onChange={(e) => toggleScope(scope, e.target.checked)}
              />
              <span className="pl-6 text-xs text-ink-3">{text?.allows ?? scope}</span>
            </div>
          );
        })}
      </fieldset>
      {blocked && (
        <Callout tone="err" title="Couldn't return to the client">
          The answer pointed to an address this page will not open: {blocked}. Nothing was shared with the
          client. Close this tab and start again from your MCP client.
        </Callout>
      )}
      {decide.isError && (
        <Callout tone="err" title="Couldn't send your answer">
          {errorMessage(decide.error)}
        </Callout>
      )}
      <div className="flex justify-end gap-2">
        <Button disabled={working || blocked !== null} onClick={() => decide.mutate(false)}>
          Deny
        </Button>
        <Button
          variant="primary"
          loading={working}
          disabled={working || scopes.length === 0 || blocked !== null}
          onClick={() => decide.mutate(true)}
        >
          Approve
        </Button>
      </div>
    </CenteredCard>
  );
}
