/**
 * P5-04, P5-14, P5-15: how to connect an MCP client to this workspace: the server URL for clients that sign
 * in with OAuth, or the caller's own access token. The key is read when the dialog opens (the first read
 * creates it) and is whole only in the reply that created it, so the dialog holds it until it closes.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { mcpApi } from '../../api/endpoints';
import type { McpApiKey } from '../../api/types';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { confirmDialog, Dialog } from '../ui/Dialog';
import { Callout, PageLoader } from '../ui/misc';
import { type TabItem, Tabs } from '../ui/Tabs';

type ConnectTab = 'oauth' | 'token';

const TABS: Array<TabItem<ConnectTab>> = [
  { value: 'oauth', label: 'OAuth URL' },
  { value: 'token', label: 'Access token' },
];

const KEY_QUERY = ['mcp', 'api-key'] as const;

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error(`Couldn't copy the ${what.toLowerCase()}`, 'Select the text and copy it by hand.');
  }
}

function CopyBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <pre
        aria-label={label}
        className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs"
      >
        {value}
      </pre>
      <Button size="sm" icon={<Copy size={14} />} aria-label={`Copy ${label}`} onClick={() => void copyText(value, label)}>
        Copy
      </Button>
    </div>
  );
}

export function McpConnectDialog({
  onClose,
  serverUrl,
  mcpOn,
}: {
  onClose: () => void;
  serverUrl: string;
  mcpOn: boolean;
}) {
  const [tab, setTab] = useState<ConnectTab>('oauth');
  const queryClient = useQueryClient();
  const key = useQuery({
    queryKey: KEY_QUERY,
    queryFn: mcpApi.apiKey,
    // the whole key comes once: keep it while the dialog is open, forget it when it closes
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });
  const rotate = useMutation({
    mutationFn: mcpApi.rotateApiKey,
    onSuccess: (next) => {
      queryClient.setQueryData<McpApiKey>(KEY_QUERY, next);
      toast.success('New key created', 'The old key stopped working.');
    },
    onError: (error) => toast.error("Couldn't rotate the key", errorMessage(error)),
  });

  const rotateKey = async () => {
    const ok = await confirmDialog({
      title: 'Rotate your MCP key?',
      description: 'The current key stops working at once. Update every client that uses it.',
      confirmLabel: 'Rotate key',
      tone: 'danger',
    });
    if (ok) rotate.mutate();
  };

  const secret = key.data;
  const config = JSON.stringify(
    {
      mcpServers: {
        workflow: {
          url: serverUrl,
          headers: { Authorization: `Bearer ${secret?.key ?? '<your MCP key>'}` },
        },
      },
    },
    null,
    2,
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title="Connect an MCP client"
      description="Let an AI client list, read and run this workspace's workflows."
      size="md"
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="flex flex-col gap-4">
        {!mcpOn && <Callout tone="warn">MCP access is off. Clients can connect after an admin turns it on.</Callout>}
        <Tabs items={TABS} value={tab} onChange={setTab} label="Connection method" />
        {tab === 'oauth' ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-2">
              Add this URL as a remote MCP server in your client. It opens a sign-in page here, and you approve
              what the client may do.
            </p>
            <CopyBox label="Server URL" value={serverUrl} />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-2">
              For clients that take a header. This key is yours: it acts as you, with your role in this
              workspace.
            </p>
            {key.isLoading ? (
              <PageLoader label="Loading your key" />
            ) : key.isError || !secret ? (
              <Callout tone="err" title="Couldn't load your key">
                {errorMessage(key.error)}
              </Callout>
            ) : (
              <>
                {secret.revealed ? (
                  <Callout tone="warn" title="Copy this key now">
                    It is shown once. After you close this window only its start is shown.
                  </Callout>
                ) : (
                  <Callout>Only the start of your key is shown. Rotate it to get a new one.</Callout>
                )}
                <CopyBox label="MCP key" value={secret.key} />
                {secret.revealed && <CopyBox label="Client config" value={config} />}
                <div>
                  <Button
                    size="sm"
                    icon={<RefreshCw size={14} />}
                    loading={rotate.isPending}
                    onClick={() => void rotateKey()}
                  >
                    Rotate key
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
