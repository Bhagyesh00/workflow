/**
 * Publish dialog (P3-10, as n8n WorkflowPublishModal): an optional version name and description,
 * stored on the version that goes live. Rendered by EditorTopBar; opened by requestPublish()
 * through ui.publishDialogOpen, for the draft or for the version in usePublishTarget.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { workflowsApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { PublishBody } from '../../api/types';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { FormField, TextArea, TextInput } from '../../components/ui/Field';
import { useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { usePublishTarget } from './publish-actions';

export const VERSION_NAME_MAX = 128;
export const VERSION_DESCRIPTION_MAX = 2000;

export function PublishDialog({ onPublish }: { onPublish: (body: PublishBody) => void }) {
  const open = useUiStore((s) => s.publishDialogOpen);
  const setOpen = useUiStore((s) => s.setPublishDialogOpen);
  const target = usePublishTarget((s) => s.versionId);
  const workflowId = useWorkflowStore((s) => s.meta.id);
  const draftVersionId = useWorkflowStore((s) => s.meta.versionId);
  const dirty = useWorkflowStore((s) => s.dirty);
  // the version whose name and description fill the form (a dirty draft becomes a new version)
  const shownVersion = target ?? (dirty ? undefined : draftVersionId);
  const version = useQuery({
    queryKey: [...queryKeys.versions(workflowId ?? 'new'), shownVersion ?? 'draft'],
    queryFn: () => workflowsApi.version(workflowId!, shownVersion!),
    enabled: open && Boolean(workflowId && shownVersion),
  });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(version.data?.versionName ?? '');
    setDescription(version.data?.description ?? '');
  }, [open, version.data]);

  const close = () => {
    setOpen(false);
    usePublishTarget.setState({ versionId: null });
  };
  const trimmed = name.trim();
  const invalid =
    trimmed.length > VERSION_NAME_MAX
      ? `Keep the name to ${VERSION_NAME_MAX} characters`
      : description.length > VERSION_DESCRIPTION_MAX
        ? `Keep the description to ${VERSION_DESCRIPTION_MAX} characters`
        : null;
  const submit = () => {
    if (invalid) return;
    const body: PublishBody = {};
    if (target) body.versionId = target;
    if (trimmed) body.versionName = trimmed;
    if (description.trim()) body.description = description;
    close();
    onPublish(body);
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title={target ? 'Publish this version' : 'Publish workflow'}
      description={
        target
          ? 'This version replaces the published one. Triggers and production webhooks run it; the draft stays as it is.'
          : 'The saved draft goes live. Triggers and production webhooks run it; later saves change only the draft.'
      }
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={Boolean(invalid)}>
            Publish
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <FormField label="Version name" hint="Optional. Shown in the version history and on executions.">
          {(id) => (
            <TextInput
              id={id}
              data-autofocus
              value={name}
              maxLength={VERSION_NAME_MAX}
              placeholder="For example: Launch"
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Description" error={invalid}>
          {(id) => (
            <TextArea
              id={id}
              rows={3}
              value={description}
              maxLength={VERSION_DESCRIPTION_MAX}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </FormField>
      </form>
    </Dialog>
  );
}
