/**
 * Name dialog of "Convert to sub-workflow" (P3-05), open while ui.convertOpen; calls
 * convertToSubWorkflow (features/editor/convert-to-subworkflow.ts) for the selected nodes. A
 * selection the extraction rules refuse closes it again with the rule text as an error toast.
 */
import { useEffect, useRef, useState } from 'react';
import {
  convertToSubWorkflow,
  DEFAULT_SUBWORKFLOW_NAME,
  extractionProblems,
  SUBWORKFLOW_NAME_MAX,
  subWorkflowNameError,
} from '../../features/editor/convert-to-subworkflow';
import type { EditorDeps } from '../../features/editor/editor-actions';
import { toast, useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { FormField, TextInput } from '../ui/Field';

export function ConvertDialog({ deps }: { deps: EditorDeps }) {
  const open = useUiStore((s) => s.convertOpen);
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const [nodeNames, setNodeNames] = useState<string[]>([]);
  const [name, setName] = useState(DEFAULT_SUBWORKFLOW_NAME);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setNodeNames([]);
      return;
    }
    const selected = useWorkflowStore.getState().selection.nodes;
    const problems = selected.length
      ? extractionProblems(depsRef.current, selected)
      : [{ code: 'generic' as const, message: 'Select the nodes to convert.' }];
    if (problems.length) {
      toast.error('Could not convert to a sub-workflow', problems.map((p) => p.message).join(' '));
      useUiStore.getState().setConvertOpen(false);
      return;
    }
    setNodeNames(selected);
    setName(DEFAULT_SUBWORKFLOW_NAME);
    setTouched(false);
    setBusy(false);
  }, [open]);

  const close = () => {
    if (!busy) useUiStore.getState().setConvertOpen(false);
  };
  const invalid = subWorkflowNameError(name);
  const submit = async () => {
    setTouched(true);
    if (invalid || busy) return;
    setBusy(true);
    const result = await convertToSubWorkflow(depsRef.current, { nodeNames, name });
    setBusy(false);
    if (result) useUiStore.getState().setConvertOpen(false);
  };
  const count = nodeNames.length;

  return (
    <Dialog
      open={open && count > 0}
      onClose={close}
      dismissible={!busy}
      size="sm"
      title="Convert to sub-workflow"
      description={`Move ${count === 1 ? '1 node' : `${count} nodes`} to a new workflow. One Execute Workflow node replaces ${count === 1 ? 'it' : 'them'} here and calls the new workflow.`}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            Convert
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <FormField label="Sub-workflow name" error={touched ? invalid : null}>
          {(id) => (
            <TextInput
              id={id}
              data-autofocus
              value={name}
              maxLength={SUBWORKFLOW_NAME_MAX + 20}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={touched && Boolean(invalid)}
            />
          )}
        </FormField>
      </form>
    </Dialog>
  );
}
