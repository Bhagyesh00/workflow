/**
 * P5-71 (L8): `/settings/assistant` (admin): on or off, model, search, permissions, parameter values; mounts
 * `AssistantMcpConnections` (L9). Each switch and select saves on its own with PATCH /assistant/settings; the
 * model has a Save button. The server checks the role and every value again. Below admin there is no nav link;
 * opened directly, the page says who can change it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ASSISTANT_ALWAYS_ALLOW_KEYS, type AssistantPermissionKey } from '@workflow/workflow';
import type { ReactNode } from 'react';
import { errorMessage } from '../api/client';
import { assistantApi } from '../api/endpoints';
import { queryKeys, useMe } from '../api/queries';
import type { AssistantPermissionMode, AssistantSettingsDTO, AssistantSettingsPatchBody } from '../api/types';
import { AssistantModelForm, useSearchCredentials } from '../components/assistant/AssistantWizard';
import { AssistantMcpConnections } from '../components/settings/AssistantMcpConnections';
import { FormField, Select, Switch } from '../components/ui/Field';
import { Callout, PageLoader } from '../components/ui/misc';
import { canWith } from '../lib/permissions';
import { toast } from '../stores/ui-store';

/** shown on the `mcpRead` row: a server's own read-only hint is not proof */
export const MCP_READ_NOTE = "The server says these tools only read. We can't check that.";

const SEARCH_OFF = '__off';

/** the 22 tools in plain words, grouped as the table shows them */
const PERMISSION_ROWS: Array<{ key: AssistantPermissionKey; label: string; note?: string }> = [
  { key: 'createWorkflow', label: 'Create workflows' },
  { key: 'updateWorkflow', label: 'Change workflows' },
  { key: 'runWorkflow', label: 'Run workflows' },
  { key: 'publishWorkflow', label: 'Publish workflows' },
  { key: 'deleteWorkflow', label: 'Delete workflows' },
  { key: 'restoreWorkflowVersion', label: 'Restore an older version of a workflow' },
  { key: 'executeNode', label: 'Run a single node' },
  { key: 'cleanupTestExecutions', label: 'Clean up test executions' },
  { key: 'createCredential', label: 'Create credentials' },
  { key: 'deleteCredential', label: 'Delete credentials' },
  { key: 'createFolder', label: 'Create folders' },
  { key: 'deleteFolder', label: 'Delete folders' },
  { key: 'moveWorkflowToFolder', label: 'Move workflows to a folder' },
  { key: 'tagWorkflow', label: 'Tag workflows' },
  { key: 'createDataTable', label: 'Create data tables' },
  { key: 'deleteDataTable', label: 'Delete data tables' },
  { key: 'mutateDataTableSchema', label: 'Change data table columns' },
  { key: 'mutateDataTableRows', label: 'Add, change and delete data table rows' },
  { key: 'fetchUrl', label: 'Read a web page' },
  { key: 'webSearch', label: 'Search the web' },
  { key: 'mcpRead', label: 'Use tools from your MCP servers that read', note: MCP_READ_NOTE },
  { key: 'mcpWrite', label: 'Use tools from your MCP servers that change things' },
];

const MODE_LABEL: Record<AssistantPermissionMode, string> = {
  require_approval: 'Ask me first',
  always_allow: 'Always allow',
  blocked: 'Blocked',
};

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4" aria-label={title}>
      <div>
        <h3 className="text-md font-semibold">{title}</h3>
        {description && <p className="mt-1 text-sm text-ink-2">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function SwitchRow({
  title,
  hint,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  hint: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="mt-1 text-xs text-ink-2">{hint}</p>
      </div>
      <Switch label={title} checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  );
}

export function AssistantSettingsPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const isAdmin = canWith(me.data, 'instanceAi:manage');
  const settings = useQuery({
    queryKey: queryKeys.assistantSettings,
    queryFn: assistantApi.settings,
    enabled: isAdmin,
    retry: false,
  });
  const search = useSearchCredentials();

  /** the page's copy and the link in the nav (`features.assistant`) follow every saved change */
  const saved = async (dto: AssistantSettingsDTO) => {
    queryClient.setQueryData(queryKeys.assistantSettings, dto);
    await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
  };

  const patch = useMutation({
    mutationFn: (body: AssistantSettingsPatchBody) => assistantApi.patchSettings(body),
    onSuccess: saved,
    onError: (error) => toast.error("Couldn't save the Assistant settings", errorMessage(error)),
  });

  if (me.isLoading) return <PageLoader />;
  const header = (
    <div>
      <h2 className="text-lg font-semibold">Assistant</h2>
      <p className="mt-1 text-sm text-ink-2">
        The Assistant answers questions about your workspace and builds workflows with you. It asks before it
        changes anything.
      </p>
    </div>
  );
  if (!isAdmin) {
    return (
      <section className="flex max-w-2xl flex-col gap-4">
        {header}
        <Callout>Only admins can change the Assistant settings.</Callout>
      </section>
    );
  }
  if (settings.isPending) return <PageLoader label="Loading the Assistant settings" />;
  if (settings.isError) {
    return (
      <section className="flex max-w-2xl flex-col gap-4">
        {header}
        <Callout tone="err">{`Couldn't load the Assistant settings. ${errorMessage(settings.error)}`}</Callout>
      </section>
    );
  }

  const dto = settings.data;
  const searchValue = dto.searchDisabled ? SEARCH_OFF : (dto.searchCredentialId ?? '');
  const busy = patch.isPending;

  const chooseSearch = (value: string) => {
    if (value === SEARCH_OFF) patch.mutate({ searchDisabled: true });
    else if (value === '') patch.mutate({ searchCredentialId: null, searchDisabled: false });
    else patch.mutate({ searchCredentialId: value });
  };

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      {header}

      <Section title="Availability">
        <SwitchRow
          title="Turn the Assistant on"
          hint="When off, nobody in this workspace can open the Assistant."
          checked={dto.enabled}
          disabled={busy}
          onChange={(enabled) => patch.mutate({ enabled })}
        />
        {!dto.modelSet && (
          <Callout tone="warn" title="No model is set">
            Choose a model below. Until then members can't use the Assistant, and they don't see it in the
            menu.
          </Callout>
        )}
      </Section>

      <Section
        title="Model"
        description="The Assistant runs on your own credential: requests go from this server to the provider you choose."
      >
        <AssistantModelForm
          initial={dto}
          onSaved={async (next) => {
            await saved(next);
            toast.success('Assistant model saved');
          }}
        />
      </Section>

      <Section title="Web search" description="Lets the Assistant look things up on the web.">
        <FormField
          label="Search key"
          hint={
            search.list.length || search.isLoading
              ? 'A Brave Search or SearXNG credential.'
              : 'No Brave Search or SearXNG credential yet. Create one on the Credentials page.'
          }
        >
          {(id) => (
            <Select
              id={id}
              value={searchValue}
              disabled={busy}
              onChange={(e) => chooseSearch(e.target.value)}
            >
              <option value="">Not set</option>
              <option value={SEARCH_OFF}>Off</option>
              {search.list.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </Section>

      <Section title="MCP servers">
        <SwitchRow
          title="Let the Assistant use MCP servers"
          hint="Adds tools from outside MCP servers you list here. Their tools ask for approval unless you allow them below."
          checked={dto.mcpAccessEnabled}
          disabled={busy}
          onChange={(mcpAccessEnabled) => patch.mutate({ mcpAccessEnabled })}
        />
        {dto.mcpAccessEnabled && <AssistantMcpConnections />}
      </Section>

      <Section
        title="Permissions"
        description="What the Assistant may do without asking. Tools that change things ask first, always."
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Assistant permissions">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-2">
                <th className="py-2 pr-3 font-semibold">Tool</th>
                <th className="py-2 font-semibold">When the Assistant wants to use it</th>
              </tr>
            </thead>
            <tbody>
              {PERMISSION_ROWS.map((row) => {
                const canAlways = ASSISTANT_ALWAYS_ALLOW_KEYS.includes(row.key);
                const modes: AssistantPermissionMode[] = canAlways
                  ? ['require_approval', 'always_allow', 'blocked']
                  : ['require_approval', 'blocked'];
                return (
                  <tr key={row.key} className="border-b border-line last:border-b-0">
                    <td className="py-2 pr-3 align-top">
                      <label htmlFor={`permission-${row.key}`} className="font-medium text-ink">
                        {row.label}
                      </label>
                      {row.note && <p className="mt-0.5 text-xs text-ink-2">{row.note}</p>}
                    </td>
                    <td className="py-2 align-top">
                      <Select
                        id={`permission-${row.key}`}
                        value={dto.permissions[row.key]}
                        disabled={busy}
                        onChange={(e) =>
                          patch.mutate({
                            permissions: { [row.key]: e.target.value as AssistantPermissionMode },
                          })
                        }
                      >
                        {modes.map((mode) => (
                          <option key={mode} value={mode}>
                            {MODE_LABEL[mode]}
                          </option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Data sharing">
        <SwitchRow
          title="Send parameter values"
          hint={
            dto.instanceAllowsSendingParameterValues
              ? 'When off, the model sees only the structure of your workflows and run data, never the values. Secrets are always removed.'
              : 'Your server turned this off, so the model never sees parameter values.'
          }
          checked={dto.instanceAllowsSendingParameterValues && dto.allowSendingParameterValues}
          disabled={busy || !dto.instanceAllowsSendingParameterValues}
          onChange={(allowSendingParameterValues) => patch.mutate({ allowSendingParameterValues })}
        />
      </Section>
    </section>
  );
}

/** every permission key the table covers (a test checks it against the shared list) */
export const ASSISTANT_PERMISSION_ROW_KEYS: readonly AssistantPermissionKey[] = PERMISSION_ROWS.map(
  (row) => row.key,
);
