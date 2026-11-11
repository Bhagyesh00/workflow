/**
 * P6-83 (L15): Settings > Security, the public API rate limits. Gates itself on `securitySettings:manage`, as
 * WorkflowReviewsSection. One switch, four limits and four windows (read and write, global and per endpoint,
 * counted per API key); 0 means no limit. Not enabled: each key keeps 600 calls per minute.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { errorMessage } from '../../api/client';
import { rateLimitsApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { RateLimitSettings } from '../../api/types';
import { usePermissions } from '../../lib/permissions';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { FormField, Switch, TextInput } from '../ui/Field';
import { Callout, Spinner } from '../ui/misc';

type NumberField = Exclude<keyof RateLimitSettings, 'enabled'>;
type Draft = Record<NumberField, string> & { enabled: boolean };

const GROUPS: ReadonlyArray<{
  title: string;
  fields: ReadonlyArray<{ limit: NumberField; window: NumberField; name: string }>;
}> = [
  {
    title: 'All endpoints together',
    fields: [
      { limit: 'globalReadLimit', window: 'globalReadWindow', name: 'Global read' },
      { limit: 'globalWriteLimit', window: 'globalWriteWindow', name: 'Global write' },
    ],
  },
  {
    title: 'Each endpoint',
    fields: [
      { limit: 'endpointReadLimit', window: 'endpointReadWindow', name: 'Endpoint read' },
      { limit: 'endpointWriteLimit', window: 'endpointWriteWindow', name: 'Endpoint write' },
    ],
  },
];

const FIELDS = GROUPS.flatMap((g) => g.fields);

const draftOf = (s: RateLimitSettings): Draft => {
  const draft = { enabled: s.enabled } as Draft;
  for (const f of FIELDS) {
    draft[f.limit] = String(s[f.limit]);
    draft[f.window] = String(s[f.window]);
  }
  return draft;
};

/** the problem of one field, or undefined */
function problem(value: string, min: number): string | undefined {
  if (!/^\d+$/.test(value.trim())) return 'Enter a whole number';
  if (Number(value) < min) return `Enter ${min} or more`;
  return undefined;
}

export function RateLimitsSection(): ReactNode {
  const { can } = usePermissions();
  const canManage = can('securitySettings:manage');
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.rateLimits,
    queryFn: () => rateLimitsApi.get(),
    enabled: canManage,
  });
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    if (query.data) setDraft(draftOf(query.data));
  }, [query.data]);

  const save = useMutation({
    mutationFn: (body: Partial<RateLimitSettings>) => rateLimitsApi.update(body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.rateLimits });
      toast.success('Rate limits saved');
    },
    onError: (error) => toast.error('Couldn’t save the rate limits', errorMessage(error)),
  });

  if (!canManage) return null;
  if (query.isError)
    return <Callout tone="err">Couldn&apos;t load the rate limits. {errorMessage(query.error)}</Callout>;
  if (!query.data || !draft)
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface p-4 text-sm text-ink-2">
        <Spinner /> Loading rate limits
      </div>
    );

  const saved = draftOf(query.data);
  const errors: Partial<Record<NumberField, string>> = {};
  for (const f of FIELDS) {
    const limitError = problem(draft[f.limit], 0);
    const windowError = problem(draft[f.window], 1);
    if (limitError) errors[f.limit] = limitError;
    if (windowError) errors[f.window] = windowError;
  }
  const dirty = (Object.keys(saved) as Array<keyof Draft>).some((k) => saved[k] !== draft[k]);
  const invalid = Object.keys(errors).length > 0;

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const submit = () => {
    const body: Partial<RateLimitSettings> = {};
    if (draft.enabled !== saved.enabled) body.enabled = draft.enabled;
    for (const f of FIELDS) {
      for (const k of [f.limit, f.window]) {
        if (draft[k] !== saved[k]) body[k] = Number(draft[k]);
      }
    }
    save.mutate(body);
  };

  return (
    <section
      aria-labelledby="rate-limits-label"
      className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p id="rate-limits-label" className="font-semibold text-ink">
            Public API rate limits
          </p>
          <p className="mt-1 text-sm text-ink-2">
            Limit how often each API key can call the public API. Counted per key. A call over a limit gets a
            429 answer with the X-RateLimit headers. Use 0 for no limit.
          </p>
        </div>
        <Switch
          label="Public API rate limits"
          checked={draft.enabled}
          disabled={save.isPending}
          onChange={(enabled) => set({ enabled })}
        />
      </div>
      {!draft.enabled && (
        <Callout>
          Not enabled: each API key can make 600 calls per minute, whatever the numbers below say.
        </Callout>
      )}
      {GROUPS.map((group) => (
        <fieldset key={group.title} className="flex flex-col gap-3" disabled={save.isPending}>
          <legend className="mb-2 text-sm font-semibold text-ink">{group.title}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {group.fields.map((f) => (
              <div key={f.limit} className="grid grid-cols-2 gap-3">
                <FormField label={`${f.name} limit`} error={errors[f.limit]}>
                  {(id) => (
                    <TextInput
                      id={id}
                      inputMode="numeric"
                      value={draft[f.limit]}
                      onChange={(e) => set({ [f.limit]: e.target.value })}
                    />
                  )}
                </FormField>
                <FormField label={`${f.name} window (seconds)`} error={errors[f.window]}>
                  {(id) => (
                    <TextInput
                      id={id}
                      inputMode="numeric"
                      value={draft[f.window]}
                      onChange={(e) => set({ [f.window]: e.target.value })}
                    />
                  )}
                </FormField>
              </div>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="flex justify-end">
        <Button variant="primary" disabled={!dirty || invalid || save.isPending} onClick={submit}>
          Save rate limits
        </Button>
      </div>
    </section>
  );
}
