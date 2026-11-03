/**
 * Create / edit a credential. The form is rendered from the credential type's properties;
 * secrets come back as `__REDACTED__` and are sent back unchanged unless replaced.
 * OAuth2 and OAuth1 types connect through a popup (GET /oauth2/authorize or /oauth1/authorize, then a window message).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type NodeParameters, resolveNodeParameters, type WorkflowNode } from '@workflow/workflow';
import { CheckCircle2, KeyRound, Link2, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';
import { credentialsApi } from '../../api/endpoints';
import { queryKeys, useCredentialTypes, useSettings } from '../../api/queries';
import type { CredentialTestResult } from '../../api/types';
import { setIn } from '../../lib/workflow-ops';
import { toast } from '../../stores/ui-store';
import { NodeIcon } from '../NodeIcon';
import { ParameterContext, type ParameterContextValue } from '../parameters/context';
import { ParameterList } from '../parameters/ParameterForm';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { FormField, TextInput } from '../ui/Field';
import { Callout, PageLoader } from '../ui/misc';

export interface CredentialModalProps {
  open: boolean;
  onClose: () => void;
  /** edit an existing credential */
  credentialId?: string | null;
  /** create a new credential of this type */
  type?: string | null;
  onSaved?: (credential: { id: string; name: string; type: string }) => void;
}

/** BroadcastChannel the OAuth2 callback page announces its result on (it shares the editor's origin). */
export const OAUTH2_CHANNEL = 'wf-oauth2';
/** how long a sign-in may take before the modal stops listening for its result */
const OAUTH2_WAIT_MS = 10 * 60_000;

/** Interpret the message the OAuth2 callback page posts to its opener. */
export function interpretOAuthMessage(data: unknown): { ok: boolean; message?: string } | null {
  if (data === 'success') return { ok: true };
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.success === true || d.status === 'success' || d.type === 'oauth2:success') return { ok: true };
  if (d.success === false || d.status === 'error' || d.type === 'oauth2:error' || d.error) {
    const message =
      typeof d.error === 'string' ? d.error : typeof d.message === 'string' ? d.message : undefined;
    return { ok: false, message };
  }
  return null;
}

export function CredentialModal({ open, onClose, credentialId, type, onSaved }: CredentialModalProps) {
  const queryClient = useQueryClient();
  const credentialTypes = useCredentialTypes();
  const settings = useSettings();
  const existing = useQuery({
    queryKey: queryKeys.credential(credentialId ?? 'new'),
    queryFn: () => credentialsApi.get(credentialId!),
    enabled: open && Boolean(credentialId),
    staleTime: 0,
  });
  const typeName = existing.data?.type ?? type ?? '';
  const typeDescription = credentialTypes.get(typeName);
  const isOAuth = Boolean(typeDescription?.isOAuth2 || typeDescription?.isOAuth1);
  const properties = useMemo(() => credentialTypes.properties(typeName), [credentialTypes, typeName]);

  const [name, setName] = useState('');
  const [data, setData] = useState<NodeParameters>({});
  const [savedId, setSavedId] = useState<string | null>(credentialId ?? null);
  const [testResult, setTestResult] = useState<CredentialTestResult | null>(null);
  const [oauthState, setOauthState] = useState<'idle' | 'waiting' | 'connected' | 'failed'>('idle');
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!open) return;
    setTestResult(null);
    setOauthState('idle');
    setSavedId(credentialId ?? null);
    if (credentialId && existing.data) {
      setName(existing.data.name);
      setData(existing.data.data ?? {});
    } else if (!credentialId) {
      setName(typeDescription ? `${typeDescription.displayName} account` : '');
      setData({});
    }
  }, [open, credentialId, existing.data, typeDescription]);

  useEffect(() => () => cleanupRef.current?.(), []);

  // hidden properties (OAuth2 token data) are written by the server only; the form never sends them
  const payloadData = () => {
    const visible = new Set(properties.filter((p) => p.type !== 'hidden').map((p) => p.name));
    const hidden = new Set(
      properties.filter((p) => p.type === 'hidden' && !visible.has(p.name)).map((p) => p.name),
    );
    return Object.fromEntries(
      Object.entries(resolveNodeParameters(properties, data)).filter(([key]) => !hidden.has(key)),
    ) as NodeParameters;
  };

  const save = useMutation({
    mutationFn: async () => {
      const body = { name: name.trim() || 'Untitled credential', data: payloadData() };
      if (savedId) return credentialsApi.update(savedId, body);
      return credentialsApi.create({ ...body, type: typeName });
    },
    onSuccess: async (credential) => {
      setSavedId(credential.id);
      await queryClient.invalidateQueries({ queryKey: ['credentials'] });
      await queryClient.invalidateQueries({ queryKey: queryKeys.credential(credential.id) });
      toast.success('Credential saved', credential.name);
      onSaved?.(credential);
      if (!isOAuth) onClose();
    },
    onError: (error) => toast.error('Could not save the credential', errorMessage(error)),
  });

  const test = useMutation({
    mutationFn: () => credentialsApi.test({ type: typeName, data: payloadData(), id: savedId ?? undefined }),
    onSuccess: setTestResult,
    onError: (error) => setTestResult({ status: 'Error', message: errorMessage(error) }),
  });

  const connectOAuth = async () => {
    if (!savedId) return;
    cleanupRef.current?.();
    try {
      const { url } = await (typeDescription?.isOAuth1
        ? credentialsApi.oauth1Authorize(savedId)
        : credentialsApi.oauth2Authorize(savedId));
      const target = new URL(url, window.location.origin);
      if (target.protocol !== 'https:' && target.protocol !== 'http:')
        throw new Error('Unsupported authorization URL');
      const popup = window.open(target.href, 'wf-oauth2', 'width=620,height=760');
      if (!popup) throw new Error('The browser blocked the sign-in window. Allow pop-ups and try again.');
      setOauthState('waiting');
      const allowedOrigins = new Set([window.location.origin]);
      try {
        allowedOrigins.add(new URL(settings.baseUrl).origin);
      } catch {
        // baseUrl may be empty in development
      }
      const finish = (result: { ok: boolean; message?: string }) => {
        cleanup();
        setOauthState(result.ok ? 'connected' : 'failed');
        if (result.ok) {
          toast.success('Account connected');
          void queryClient.invalidateQueries({ queryKey: queryKeys.credential(savedId) });
        } else toast.error('Connection failed', result.message);
      };
      const onMessage = (event: MessageEvent) => {
        if (!allowedOrigins.has(event.origin) || event.source !== popup) return;
        const result = interpretOAuthMessage(event.data);
        if (result) finish(result);
      };
      // the callback page also announces the result to every editor tab of its origin, which still
      // works when a provider page with its own opener policy cut the popup off from this window
      const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(OAUTH2_CHANNEL);
      if (channel) {
        channel.onmessage = (event: MessageEvent) => {
          if ((event.data as { credentialId?: unknown } | null)?.credentialId !== savedId) return;
          const result = interpretOAuthMessage(event.data);
          if (result) finish(result);
        };
      }
      // a cut-off popup reads as closed while the user still signs in, so closed is not the end:
      // go back to idle without an error (closing the popup is how users cancel) and keep listening
      const timer = window.setInterval(() => {
        if (!popup.closed) return;
        window.clearInterval(timer);
        setOauthState((s) => (s === 'waiting' ? 'idle' : s));
      }, 500);
      const expiry = window.setTimeout(() => cleanup(), OAUTH2_WAIT_MS);
      const cleanup = () => {
        window.removeEventListener('message', onMessage);
        window.clearInterval(timer);
        window.clearTimeout(expiry);
        channel?.close();
        cleanupRef.current = null;
      };
      cleanupRef.current = cleanup;
      window.addEventListener('message', onMessage);
    } catch (error) {
      setOauthState('failed');
      toast.error('Could not start the connection', errorMessage(error));
    }
  };

  const node: WorkflowNode = useMemo(
    () => ({
      id: 'credential',
      name: 'credential',
      type: typeName,
      typeVersion: 1,
      position: [0, 0],
      parameters: data,
    }),
    [typeName, data],
  );
  const context: ParameterContextValue = useMemo(
    () => ({
      node,
      rootValues: data,
      readOnly: false,
      allowExpressions: false,
      keepSecretOnEmpty: Boolean(savedId),
      onChange: (path, value) => {
        setTestResult(null);
        setData((d) => setIn(d, path, value) as NodeParameters);
      },
    }),
    [node, data, savedId],
  );

  const loading = Boolean(credentialId) && existing.isLoading;
  const loadFailed = Boolean(credentialId) && existing.isError;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <span className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-surface-3 text-ink-2">
            {typeDescription?.icon ? (
              <NodeIcon
                description={{ ...typeDescription, name: typeDescription.name, icon: typeDescription.icon }}
                size={16}
              />
            ) : (
              <KeyRound size={16} />
            )}
          </span>
          {credentialId ? 'Edit credential' : `New ${typeDescription?.displayName ?? 'credential'}`}
        </span>
      }
      description={
        typeDescription?.documentationUrl && /^https?:\/\//.test(typeDescription.documentationUrl) ? (
          <a
            href={typeDescription.documentationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand underline"
          >
            How to get these values
          </a>
        ) : undefined
      }
      footer={
        <>
          {testResult && (
            <span
              className={`mr-auto inline-flex items-center gap-1.5 text-sm ${testResult.status === 'OK' ? 'text-ok' : 'text-err'}`}
              role="status"
            >
              {testResult.status === 'OK' ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
              {testResult.status === 'OK' ? 'Connection works' : testResult.message || 'Connection failed'}
            </span>
          )}
          {typeDescription?.test && (
            <Button onClick={() => test.mutate()} loading={test.isPending} disabled={!typeName}>
              Test connection
            </Button>
          )}
          {isOAuth && savedId && (
            <Button
              icon={<Link2 size={14} />}
              onClick={() => void connectOAuth()}
              loading={oauthState === 'waiting'}
            >
              {oauthState === 'connected' ? 'Reconnect account' : 'Connect account'}
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!typeName || loadFailed}
          >
            Save
          </Button>
        </>
      }
    >
      {loading ? (
        <PageLoader />
      ) : loadFailed ? (
        <Callout tone="err" title="Couldn't load the credential">
          {errorMessage(existing.error)}
        </Callout>
      ) : !typeDescription ? (
        <Callout tone="err" title="Unknown credential type">
          The type “{typeName}” is not available on this server.
        </Callout>
      ) : (
        <div className="flex flex-col gap-5">
          <FormField label="Name">
            {(id) => (
              <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
            )}
          </FormField>
          <ParameterContext.Provider value={context}>
            <ParameterList properties={properties} values={data} path={[]} />
          </ParameterContext.Provider>
          {isOAuth && !savedId && (
            <Callout tone="info">Save the credential first, then connect your account.</Callout>
          )}
          {oauthState === 'connected' && <Callout tone="ok">Account connected.</Callout>}
        </div>
      )}
    </Dialog>
  );
}
