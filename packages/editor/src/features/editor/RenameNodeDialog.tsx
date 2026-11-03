/**
 * Small rename dialog for ui.renameTarget (F2, menu "Rename"): same store path as the NDV
 * (store.renameNode); a RenameError (empty, duplicate name) shows under the field.
 */
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { TextInput } from '../../components/ui/Field';
import { RenameError } from '../../lib/workflow-ops';
import { useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';

export function RenameNodeDialog() {
  const target = useUiStore((s) => s.renameTarget);
  const close = () => useUiStore.getState().setRenameTarget(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(target ?? '');
    setError(null);
  }, [target]);

  const submit = () => {
    if (!target) return;
    const next = name.trim();
    if (next === target) return close();
    try {
      useWorkflowStore.getState().renameNode(target, next);
      useWorkflowStore.getState().select({ nodes: [next], stickies: [], edges: [] });
      close();
    } catch (e) {
      setError(e instanceof RenameError ? e.message : 'Could not rename the node');
    }
  };

  return (
    <Dialog
      open={Boolean(target)}
      onClose={close}
      title="Rename node"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button onClick={submit}>Rename</Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="mb-1 block text-xs font-semibold text-ink-2" htmlFor="rename-node-name">
          Node name
        </label>
        <TextInput
          id="rename-node-name"
          data-autofocus
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          onFocus={(event) => event.target.select()}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'rename-node-error' : undefined}
        />
        {error && (
          <p id="rename-node-error" role="alert" className="mt-1.5 text-xs text-err">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
