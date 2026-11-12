/**
 * P6-64 (L8): add or edit one destination. Tabs Settings (label, the type's fields, circuit breaker) and Events
 * (`EventTree`, anonymize); Save, Send test event with the result, Delete with a confirm. Saved secrets show
 * blank with a "saved" hint; a blank keeps the saved value.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_CIRCUIT_BREAKER, EVENT_CATALOG } from '@workflow/workflow';
import { type ReactNode, useMemo, useState } from 'react';
import { errorMessage } from '../../api/client';
import { logStreamingApi } from '../../api/endpoints';
import { queryKeys, useCredentials, useEventNames } from '../../api/queries';
import type {
  LogDestination,
  LogDestinationSaveBody,
  LogDestinationSettings,
  LogDestinationTestResult,
  LogDestinationType,
  SentryDestinationSettings,
  SyslogDestinationSettings,
  WebhookDestinationSettings,
} from '../../api/types';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { confirmDialog, Dialog } from '../ui/Dialog';
import { FormField, Select, Switch, TextInput } from '../ui/Field';
import { Callout } from '../ui/misc';
import { Tabs } from '../ui/Tabs';
import { DESTINATION_TYPE_NAMES } from './DestinationCard';
import { EventTree } from './EventTree';
import { SentryFields } from './SentryFields';
import { SyslogFields } from './SyslogFields';
import { WebhookFields } from './WebhookFields';

export interface DestinationModalProps {
  open: boolean;
  /** the type picked in "Add destination", or the edited destination's type */
  type: LogDestinationType;
  /** null for a new destination */
  destination: LogDestination | null;
  onClose(): void;
  /** after a save; the page refreshes its list */
  onSaved?(destination: LogDestination): void;
}

/** the generic HTTP auth credentials a webhook can send with */
const AUTH_CREDENTIAL_TYPES = new Set([
  'httpBasicAuth',
  'httpDigestAuth',
  'httpHeaderAuth',
  'httpQueryAuth',
  'httpTemplatedCustomAuth',
]);

const DEFAULTS: Record<LogDestinationType, LogDestinationSettings> = {
  webhook: {
    url: '',
    method: 'POST',
    sendQuery: false,
    queryParameters: [],
    sendHeaders: false,
    headerParameters: [],
    sendPayload: true,
    responseCodeMustMatch: false,
    expectedStatusCode: 200,
    options: {
      allowUnauthorizedCerts: false,
      queryParameterArrays: 'brackets',
      redirect: { followRedirects: false, maxRedirects: 21 },
      timeout: 5000,
    },
  },
  syslog: { host: '', port: 514, protocol: 'udp', facility: 16, app_name: 'workflow', eol: '\n' },
  sentry: { dsn: '', sendPayload: true },
};

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function settingsOf(
  type: LogDestinationType,
  saved: LogDestinationSettings | undefined,
): LogDestinationSettings {
  const base = clone(DEFAULTS[type]);
  if (!saved) return base;
  const merged = { ...base, ...clone(saved) } as LogDestinationSettings;
  if (type === 'webhook') {
    const defaults = base as WebhookDestinationSettings;
    const own = saved as WebhookDestinationSettings;
    (merged as WebhookDestinationSettings).options = {
      ...defaults.options,
      ...own.options,
      redirect: { ...defaults.options.redirect, ...own.options?.redirect },
    };
  }
  return merged;
}

/** the request body that saves `destination` as it is, with `patch` on top (secrets stay blank, so they are kept) */
export function saveBodyOf(
  destination: LogDestination,
  patch: Partial<
    Pick<LogDestination, 'enabled' | 'label' | 'subscribedEvents' | 'anonymizeAuditMessages'>
  > = {},
): LogDestinationSaveBody {
  return {
    id: destination.id,
    type: destination.type,
    label: destination.label,
    enabled: destination.enabled,
    subscribedEvents: destination.subscribedEvents,
    anonymizeAuditMessages: destination.anonymizeAuditMessages,
    ...(destination.credentialId !== undefined ? { credentialId: destination.credentialId } : {}),
    ...(destination.circuitBreaker ? { circuitBreaker: destination.circuitBreaker } : {}),
    settings: destination.settings,
    ...patch,
  } as LogDestinationSaveBody;
}

interface Draft {
  label: string;
  enabled: boolean;
  subscribedEvents: string[];
  anonymizeAuditMessages: boolean;
  credentialId: string;
  maxFailures: number;
  windowSeconds: number;
  settings: LogDestinationSettings;
}

function draftOf(type: LogDestinationType, destination: LogDestination | null): Draft {
  const breaker = destination?.circuitBreaker ?? DEFAULT_CIRCUIT_BREAKER;
  return {
    label: destination?.label ?? '',
    enabled: destination?.enabled ?? false,
    subscribedEvents: destination ? [...destination.subscribedEvents] : [],
    anonymizeAuditMessages: destination?.anonymizeAuditMessages ?? false,
    credentialId: destination?.credentialId ?? '',
    maxFailures: breaker.maxFailures,
    windowSeconds: Math.round(breaker.failureWindowMs / 1000),
    settings: settingsOf(type, destination?.settings),
  };
}

function problemsOf(type: LogDestinationType, draft: Draft): string[] {
  const problems: string[] = [];
  if (!draft.label.trim()) problems.push('Give the destination a label.');
  if (type === 'webhook' && !(draft.settings as WebhookDestinationSettings).url.trim())
    problems.push('Enter the URL to send to.');
  if (type === 'syslog' && !(draft.settings as SyslogDestinationSettings).host.trim())
    problems.push('Enter the syslog host.');
  if (type === 'sentry' && !(draft.settings as SentryDestinationSettings).dsn.trim())
    problems.push('Enter the Sentry DSN.');
  if (!Number.isInteger(draft.maxFailures) || draft.maxFailures < 1)
    problems.push('Max failures must be 1 or more.');
  if (!(draft.windowSeconds >= 1)) problems.push('The failure window must be 1 second or more.');
  return problems;
}

export function DestinationModal({
  open,
  type,
  destination,
  onClose,
  onSaved,
}: DestinationModalProps): ReactNode {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(type, destination));
  const [baseline, setBaseline] = useState(() => JSON.stringify(draftOf(type, destination)));
  const [saved, setSaved] = useState<LogDestination | null>(destination);
  const [tab, setTab] = useState<'settings' | 'events'>('settings');
  const [problems, setProblems] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [result, setResult] = useState<LogDestinationTestResult | null>(null);

  const eventNames = useEventNames(open);
  const names = useMemo(() => eventNames.data ?? EVENT_CATALOG.map((entry) => entry.name), [eventNames.data]);
  const credentials = useCredentials(undefined, undefined, open && type === 'webhook');
  const authCredentials = (credentials.data ?? []).filter((c) => AUTH_CREDENTIAL_TYPES.has(c.type));

  const dirty = JSON.stringify(draft) !== baseline;
  const patch = (part: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...part }));
    setResult(null);
  };
  const patchSettings = (part: Partial<LogDestinationSettings>) =>
    setDraft((current) => ({
      ...current,
      settings: { ...current.settings, ...part } as LogDestinationSettings,
    }));

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.logStreaming });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...(saved ? { id: saved.id } : {}),
        type,
        label: draft.label.trim(),
        enabled: draft.enabled,
        subscribedEvents: draft.subscribedEvents,
        anonymizeAuditMessages: draft.anonymizeAuditMessages,
        ...(type === 'webhook' ? { credentialId: draft.credentialId || null } : {}),
        circuitBreaker: {
          maxFailures: draft.maxFailures,
          failureWindowMs: Math.round(draft.windowSeconds * 1000),
        },
        settings: draft.settings,
      } as LogDestinationSaveBody;
      return logStreamingApi.save(body);
    },
    onSuccess: async (next) => {
      const nextDraft = draftOf(type, next);
      setSaved(next);
      setDraft(nextDraft);
      setBaseline(JSON.stringify(nextDraft));
      setSaveError(null);
      toast.success('Destination saved');
      onSaved?.(next);
      await refresh();
    },
    onError: (error) => setSaveError(errorMessage(error)),
  });

  const test = useMutation({
    mutationFn: (id: string) => logStreamingApi.test(id),
    onSuccess: async (answer) => {
      setResult(answer);
      await refresh();
    },
    onError: (error) => setResult({ success: false, error: errorMessage(error) }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => logStreamingApi.remove(id),
    onSuccess: async () => {
      toast.success('Destination deleted');
      await refresh();
      onClose();
    },
    onError: (error) => toast.error('Could not delete the destination', errorMessage(error)),
  });

  const submit = () => {
    const found = problemsOf(type, draft);
    setProblems(found);
    if (found.length > 0) return;
    setSaveError(null);
    save.mutate();
  };

  const askDelete = async () => {
    if (!saved) return;
    const ok = await confirmDialog({
      title: `Delete ${saved.label}?`,
      description: 'The destination stops receiving events and its queue is dropped. This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (ok) remove.mutate(saved.id);
  };

  const busy = save.isPending || remove.isPending;
  const typeName = DESTINATION_TYPE_NAMES[type];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      dismissible={!busy}
      title={destination ? 'Edit destination' : `Add ${typeName.toLowerCase()} destination`}
      description={
        type === 'webhook'
          ? 'Sends each selected event to a web address.'
          : type === 'syslog'
            ? 'Sends each selected event to a syslog server.'
            : 'Sends each selected event to Sentry.'
      }
      footer={
        <>
          {saved && (
            <Button variant="danger" className="mr-auto" disabled={busy} onClick={() => void askDelete()}>
              Delete
            </Button>
          )}
          <Button
            loading={test.isPending}
            disabled={!saved || dirty || busy}
            title={
              saved ? (dirty ? 'Save your changes to test them' : undefined) : 'Save the destination first'
            }
            onClick={() => saved && test.mutate(saved.id)}
          >
            Send test event
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={remove.isPending} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {problems.length > 0 && (
          <Callout tone="err">
            <ul className="list-disc pl-4">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Callout>
        )}
        {saveError && <Callout tone="err">{saveError}</Callout>}
        {result && (
          <Callout tone={result.success ? 'ok' : 'err'}>
            {result.success
              ? 'Test event delivered.'
              : `Test event failed: ${result.error ?? 'Unknown error'}`}
          </Callout>
        )}
        <Tabs
          label="Destination sections"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'settings', label: 'Settings' },
            { value: 'events', label: 'Events' },
          ]}
        />
        {tab === 'settings' ? (
          <div className="flex flex-col gap-4">
            <FormField label="Label">
              {(id) => (
                <TextInput
                  id={id}
                  value={draft.label}
                  data-autofocus
                  onChange={(e) => patch({ label: e.target.value })}
                />
              )}
            </FormField>
            <div className="flex items-start gap-3">
              <Switch checked={draft.enabled} onChange={(enabled) => patch({ enabled })} label="Enabled" />
              <div className="text-sm">
                <p className="font-semibold text-ink">Enabled</p>
                <p className="text-ink-2">A destination that is off receives nothing.</p>
              </div>
            </div>
            {type === 'webhook' && (
              <>
                <WebhookFields
                  value={draft.settings as WebhookDestinationSettings}
                  onChange={patchSettings}
                  saved={Boolean(saved)}
                />
                <FormField
                  label="Credential"
                  hint="A generic HTTP authentication credential of this workspace."
                >
                  {(id) => (
                    <Select
                      id={id}
                      value={draft.credentialId}
                      onChange={(e) => patch({ credentialId: e.target.value })}
                    >
                      <option value="">None</option>
                      {authCredentials.map((credential) => (
                        <option key={credential.id} value={credential.id}>
                          {credential.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </FormField>
              </>
            )}
            {type === 'syslog' && (
              <SyslogFields value={draft.settings as SyslogDestinationSettings} onChange={patchSettings} />
            )}
            {type === 'sentry' && (
              <SentryFields
                value={draft.settings as SentryDestinationSettings}
                onChange={patchSettings}
                saved={Boolean(saved)}
              />
            )}
            <fieldset className="flex flex-col gap-3 rounded-lg border border-line p-3">
              <legend className="px-1 text-sm font-semibold text-ink">Circuit breaker</legend>
              <p className="text-xs text-ink-2">
                After this many failed sends within the window the destination pauses, then tries again.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Max failures">
                  {(id) => (
                    <TextInput
                      id={id}
                      type="number"
                      min={1}
                      value={Number.isNaN(draft.maxFailures) ? '' : draft.maxFailures}
                      onChange={(e) => patch({ maxFailures: Number(e.target.value) })}
                    />
                  )}
                </FormField>
                <FormField label="Failure window (seconds)">
                  {(id) => (
                    <TextInput
                      id={id}
                      type="number"
                      min={1}
                      value={Number.isNaN(draft.windowSeconds) ? '' : draft.windowSeconds}
                      onChange={(e) => patch({ windowSeconds: Number(e.target.value) })}
                    />
                  )}
                </FormField>
              </div>
            </fieldset>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-ink-2">
              Pick the events this destination receives. A whole group also takes events added to it later.
            </p>
            <EventTree
              eventNames={names}
              value={draft.subscribedEvents}
              onChange={(subscribedEvents) => patch({ subscribedEvents })}
              anonymizeAuditMessages={draft.anonymizeAuditMessages}
              onAnonymizeChange={(anonymizeAuditMessages) => patch({ anonymizeAuditMessages })}
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}
