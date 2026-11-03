/**
 * "Import from URL" (P3-13, as n8n ImportWorkflowUrlModal): open while ui.importUrlOpen; the URL
 * must match /^https?:\/\/.+/i; workflowsApi.importFromUrl sends it in the body (the server
 * fetches it, the browser never does); the result is checked and pasted into the open workflow as
 * one undo step. A result that arrives after the user left the workflow (or closed the dialog)
 * is dropped.
 */
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';
import { workflowsApi } from '../../api/endpoints';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { FormField, TextInput } from '../../components/ui/Field';
import { parseClipboard } from '../../lib/workflow-ops';
import { toast, useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';

const URL_SHAPE = /^https?:\/\/.+/i;
const NOT_WORKFLOW = 'The data in the file does not seem to be a workflow JSON file!';

export function ImportUrlDialog() {
  const open = useUiStore((s) => s.importUrlOpen);
  const setOpen = useUiStore((s) => s.setImportUrlOpen);
  const readOnly = useWorkflowStore((s) => s.readOnly);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attempt = useRef(0);

  // every close or reopen starts clean and invalidates a request still in flight
  // biome-ignore lint/correctness/useExhaustiveDependencies: `open` is the trigger, the body does not read it
  useEffect(() => {
    attempt.current += 1;
    setUrl('');
    setError(null);
    setBusy(false);
  }, [open]);
  useEffect(
    () => () => {
      attempt.current += 1;
    },
    [],
  );

  const trimmed = url.trim();
  const valid = URL_SHAPE.test(trimmed);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!valid || busy || readOnly) return;
    const mine = ++attempt.current;
    const workflowId = useWorkflowStore.getState().meta.id;
    setBusy(true);
    setError(null);
    try {
      const data = await workflowsApi.importFromUrl(trimmed);
      if (mine !== attempt.current || useWorkflowStore.getState().meta.id !== workflowId) return;
      const shaped =
        data &&
        typeof data === 'object' &&
        Array.isArray(data.nodes) &&
        data.connections &&
        typeof data.connections === 'object' &&
        !Array.isArray(data.connections);
      const payload = shaped ? parseClipboard(JSON.stringify(data)) : null;
      if (!payload) {
        setError(NOT_WORKFLOW);
        setBusy(false);
        return;
      }
      const store = useWorkflowStore.getState();
      const names = store.paste(payload, offsetBelowExisting(payload.nodes, store.nodes));
      setOpen(false);
      toast.info(`Imported ${names.length} node${names.length === 1 ? '' : 's'}`);
    } catch (e) {
      if (mine !== attempt.current) return;
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title="Import workflow from URL"
      description="Paste the address of a workflow JSON file. It is added to this workflow."
      size="sm"
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={!valid || readOnly}
            loading={busy}
          >
            Import
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)}>
        <FormField
          label="Workflow URL"
          error={
            error ?? (trimmed && !valid ? 'Enter a URL that starts with http:// or https://' : undefined)
          }
        >
          {(id) => (
            <TextInput
              id={id}
              data-autofocus
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://example.com/workflow.json"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
            />
          )}
        </FormField>
      </form>
    </Dialog>
  );
}

/** Keep the imported block where its file put it on an empty canvas, else put it below what is there. */
function offsetBelowExisting(
  incoming: Array<{ position: [number, number] }>,
  existing: Array<{ position: [number, number] }>,
): [number, number] {
  if (!existing.length || !incoming.length) return [0, 0];
  const top = Math.min(...incoming.map((n) => n.position[1]));
  const left = Math.min(...incoming.map((n) => n.position[0]));
  const bottom = Math.max(...existing.map((n) => n.position[1]));
  const existingLeft = Math.min(...existing.map((n) => n.position[0]));
  return [Math.round(existingLeft - left), Math.round(bottom + 200 - top)];
}
