/**
 * P6-68 (L12): Settings > OpenTelemetry, at /settings/opentelemetry. Status and enable control, the
 * connection block (protocol, endpoint, path, service name, headers, timeout, Test), sampling and span
 * options, and an unsaved-changes dialog. Only for `otel:manage` (the settings link is gated on it; the server
 * is the lock); a member's visit fetches nothing. Header values never come back from the server and are never
 * shown: a saved header lists blank, and a blank value on Save keeps the stored one.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router';
import { errorMessage } from '../api/client';
import { otelApi } from '../api/endpoints';
import { queryKeys, useMe, useOtelSettings } from '../api/queries';
import type { OtelSettings, OtelTestResult } from '../api/types';
import { OtelHeadersEditor } from '../components/otel/OtelHeadersEditor';
import { OtelStatusControl } from '../components/otel/OtelStatusControl';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { Checkbox, FormField, Select, TextInput } from '../components/ui/Field';
import { Callout, PageLoader } from '../components/ui/misc';
import { usePermissions } from '../lib/permissions';
import { toast } from '../stores/ui-store';
import { Panel } from './settings/Panel';

/** a number typed as text: whole when `whole`, inside the range, else null */
function parseNumber(text: string, min: number, max: number, whole: boolean): number | null {
  const trimmed = text.trim();
  if (!trimmed || !/^\d*\.?\d+$|^\d+\.$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < min || n > max || (whole && !Number.isInteger(n))) return null;
  return n;
}

/** true when the headers text holds a header with a value (a saved header lists blank) */
function hasHeaderValue(headers: string): boolean {
  return headers.split(',').some((part) => part.includes('=') && part.slice(part.indexOf('=') + 1).trim());
}

interface TestState {
  /** the JSON of the settings the test sent: a later edit hides the result */
  sent: string;
  result: OtelTestResult;
}

function OtelForm({ data }: { data: OtelSettings }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<OtelSettings>(data);
  const [rateText, setRateText] = useState(String(data.tracesSampleRate));
  const [timeoutText, setTimeoutText] = useState(String(data.startupConnectivityTimeoutMs));
  const [tested, setTested] = useState<TestState | null>(null);

  // the answer of a save (or a reload) replaces what is on the page
  useEffect(() => {
    setDraft(data);
    setRateText(String(data.tracesSampleRate));
    setTimeoutText(String(data.startupConnectivityTimeoutMs));
  }, [data]);

  const rate = parseNumber(rateText, 0, 1, false);
  const timeout = parseNumber(timeoutText, 0, 60_000, true);
  const current: OtelSettings | null =
    rate === null || timeout === null
      ? null
      : { ...draft, tracesSampleRate: rate, startupConnectivityTimeoutMs: timeout };
  const dirty = current === null || JSON.stringify(current) !== JSON.stringify(data);
  const set = (patch: Partial<OtelSettings>) => setDraft((d) => ({ ...d, ...patch }));

  const save = useMutation({
    mutationFn: (body: OtelSettings) => otelApi.replace(body),
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.otelSettings, saved);
      toast.success('OpenTelemetry settings saved');
    },
    onError: (error) => toast.error('Could not save the OpenTelemetry settings', errorMessage(error)),
  });
  const test = useMutation({
    mutationFn: (body: OtelSettings) => otelApi.testTrace(body),
    onSuccess: (result, body) => setTested({ sent: JSON.stringify(body), result }),
    onError: (error, body) =>
      setTested({ sent: JSON.stringify(body), result: { success: false, error: errorMessage(error) } }),
  });

  // leaving with unsaved changes (in-app navigation and tab close), as the workflow editor does
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirtyRef.current && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const http = draft.exporterProtocol === 'http/protobuf';
  const headersOverHttp =
    draft.exporterEndpoint.trim().toLowerCase().startsWith('http://') &&
    hasHeaderValue(draft.exporterHeaders);
  const shownTest = tested && current && tested.sent === JSON.stringify(current) ? tested.result : null;

  return (
    <>
      <Panel
        title="OpenTelemetry"
        description="Send a trace of every workflow run in this workspace to your OpenTelemetry collector. Traces carry names, ids, counts and status, never node data or credentials."
        action={
          <OtelStatusControl
            enabled={draft.enabled}
            onChange={(enabled) => set({ enabled })}
            disabled={save.isPending}
          />
        }
      >
        <div className="flex flex-col gap-6 px-5 py-4">
          <section aria-label="Collector connection" className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold text-ink">Collector connection</h3>
            <FormField label="Protocol">
              {(id) => (
                <Select
                  id={id}
                  value={draft.exporterProtocol}
                  onChange={(e) =>
                    set({ exporterProtocol: e.target.value as OtelSettings['exporterProtocol'] })
                  }
                >
                  <option value="http/protobuf">HTTP (protobuf)</option>
                  <option value="grpc">gRPC</option>
                </Select>
              )}
            </FormField>
            <FormField label="Endpoint" hint="The collector's base URL, starting with http:// or https://.">
              {(id) => (
                <TextInput
                  id={id}
                  value={draft.exporterEndpoint}
                  placeholder="https://collector.example.com:4318"
                  autoComplete="off"
                  onChange={(e) => set({ exporterEndpoint: e.target.value })}
                />
              )}
            </FormField>
            <FormField
              label="Traces path"
              hint={http ? 'Added to the endpoint, for example /v1/traces.' : 'Used by HTTP only.'}
            >
              {(id) => (
                <TextInput
                  id={id}
                  value={draft.exporterTracingPath}
                  disabled={!http}
                  onChange={(e) => set({ exporterTracingPath: e.target.value })}
                />
              )}
            </FormField>
            <FormField label="Service name">
              {(id) => (
                <TextInput
                  id={id}
                  value={draft.exporterServiceName}
                  onChange={(e) => set({ exporterServiceName: e.target.value })}
                />
              )}
            </FormField>
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-semibold text-ink">Headers</p>
              <p className="text-xs text-ink-2">
                Sent with every export, for example an API token. A saved value shows blank; leave it blank to
                keep it. Header values need an https:// endpoint, and a stored value is dropped when you
                change the endpoint's scheme, host or port.
              </p>
              <OtelHeadersEditor
                value={draft.exporterHeaders}
                onChange={(exporterHeaders) => set({ exporterHeaders })}
                disabled={save.isPending}
              />
              {headersOverHttp && (
                <Callout tone="warn">
                  Header values are only sent over https://. Use an https:// endpoint or remove the values.
                </Callout>
              )}
            </div>
            <FormField
              label="Timeout (ms)"
              hint="How long to wait for the collector when checking the connection."
            >
              {(id) => (
                <TextInput
                  id={id}
                  inputMode="numeric"
                  value={timeoutText}
                  aria-invalid={timeout === null}
                  onChange={(e) => setTimeoutText(e.target.value)}
                />
              )}
            </FormField>
            {timeout === null && <Callout tone="err">The timeout is a whole number from 0 to 60000.</Callout>}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                loading={test.isPending}
                disabled={current === null || !draft.exporterEndpoint.trim()}
                onClick={() => current && test.mutate(current)}
              >
                Send test trace
              </Button>
              {shownTest && (
                <span role="status" className={shownTest.success ? 'text-sm text-ok' : 'text-sm text-err'}>
                  {shownTest.success
                    ? 'Test trace delivered.'
                    : `Test failed: ${shownTest.error ?? 'No answer.'}`}
                </span>
              )}
            </div>
          </section>

          <section aria-label="Sampling and spans" className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-ink">Sampling and spans</h3>
            <FormField label="Sampling rate" hint="0 sends no traces, 1 sends every trace.">
              {(id) => (
                <TextInput
                  id={id}
                  inputMode="decimal"
                  value={rateText}
                  aria-invalid={rate === null}
                  onChange={(e) => setRateText(e.target.value)}
                />
              )}
            </FormField>
            {rate === null && <Callout tone="err">The sampling rate is a number from 0 to 1.</Callout>}
            <Checkbox
              label="Include node spans"
              checked={draft.includeNodeSpans}
              onChange={(e) => set({ includeNodeSpans: e.target.checked })}
            />
            <Checkbox
              label="Emit workflow start spans"
              checked={draft.emitWorkflowStartSpan}
              onChange={(e) => set({ emitWorkflowStartSpan: e.target.checked })}
            />
            <Checkbox
              label="Emit node start spans"
              checked={draft.emitNodeStartSpan}
              onChange={(e) => set({ emitNodeStartSpan: e.target.checked })}
            />
            <Checkbox
              label="Add trace headers to outbound requests"
              checked={draft.injectOutbound}
              onChange={(e) => set({ injectOutbound: e.target.checked })}
            />
            <Checkbox
              label="Production executions only"
              checked={draft.productionExecutionsOnly}
              onChange={(e) => set({ productionExecutionsOnly: e.target.checked })}
            />
          </section>

          <div>
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={!dirty || current === null}
              onClick={() => current && save.mutate(current)}
            >
              Save
            </Button>
          </div>
        </div>
      </Panel>
      <Dialog
        open={blocker.state === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="Save changes before leaving?"
        description="Your latest edits to the OpenTelemetry settings are not saved."
        size="sm"
        footer={
          <>
            <Button onClick={() => blocker.reset?.()}>Stay</Button>
            <Button variant="danger" onClick={() => blocker.proceed?.()}>
              Leave without saving
            </Button>
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={current === null}
              onClick={async () => {
                if (!current) return;
                try {
                  await save.mutateAsync(current);
                  blocker.proceed?.();
                } catch {
                  blocker.reset?.();
                }
              }}
            >
              Save and leave
            </Button>
          </>
        }
      />
    </>
  );
}

export function OtelSettingsPage(): ReactNode {
  const me = useMe();
  const { can } = usePermissions();
  const allowed = can('otel:manage');
  const settings = useOtelSettings(allowed);

  if (me.isLoading) return <PageLoader />;
  if (!allowed) return <Callout>Only admins can manage OpenTelemetry.</Callout>;
  if (settings.isLoading) return <PageLoader />;
  if (settings.error || !settings.data) {
    return (
      <Callout tone="err">
        {settings.error ? errorMessage(settings.error) : 'Could not load the OpenTelemetry settings.'}
      </Callout>
    );
  }
  return <OtelForm data={settings.data} />;
}
