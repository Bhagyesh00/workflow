/** Ask reviewers to approve the saved version before it goes live (P3-19). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { errorMessage } from '../../api/client';
import { reviewsApi } from '../../api/endpoints';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Checkbox, FormField, TextArea, TextInput } from '../../components/ui/Field';
import { Callout, PageLoader } from '../../components/ui/misc';
import { toast } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';

export function SubmitForReviewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const meta = useWorkflowStore((s) => s.meta);
  const dirty = useWorkflowStore((s) => s.dirty);
  const [title, setTitle] = useState('');
  const [versionName, setVersionName] = useState('');
  const [description, setDescription] = useState('');
  const [reviewerIds, setReviewerIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setTitle(`Review ${meta.name}`.slice(0, 128));
    setVersionName(meta.name.slice(0, 128));
    setDescription('');
    setReviewerIds([]);
  }, [open, meta.name]);

  const workflowId = meta.id;
  const reviewers = useQuery({
    queryKey: ['workflow-reviews', 'eligible', workflowId],
    queryFn: () => reviewsApi.eligibleReviewers(workflowId as string),
    enabled: open && Boolean(workflowId),
  });

  const submit = useMutation({
    mutationFn: () =>
      reviewsApi.create({
        workflowId: workflowId as string,
        versionName: versionName.trim(),
        title: title.trim(),
        description: description.trim() || undefined,
        reviewerUserIds: reviewerIds,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workflow-reviews'] });
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
      toast.success('Submitted for review', 'The reviewers can see it in their inbox.');
      onClose();
    },
    onError: (error) => toast.error('Could not submit for review', errorMessage(error)),
  });

  const valid =
    title.trim().length > 0 &&
    versionName.trim().length > 0 &&
    reviewerIds.length >= 1 &&
    reviewerIds.length <= 10;
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && !dirty) submit.mutate();
  };
  const toggle = (id: string) =>
    setReviewerIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Submit for review"
      description="Reviewers see the version you saved and can approve it. Approving publishes it."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="submit-review-form"
            loading={submit.isPending}
            disabled={!valid || dirty}
          >
            Submit for review
          </Button>
        </>
      }
    >
      <form id="submit-review-form" onSubmit={onSubmit} className="flex flex-col gap-4">
        {dirty && (
          <Callout tone="warn" title="Save your changes first">
            The review covers the saved version, and this workflow has unsaved changes.
          </Callout>
        )}
        <FormField label="Title" required>
          {(id) => (
            <TextInput
              id={id}
              value={title}
              maxLength={128}
              onChange={(event) => setTitle(event.target.value)}
              data-autofocus
            />
          )}
        </FormField>
        <FormField label="Version name" required hint="Names the version in the version history.">
          {(id) => (
            <TextInput
              id={id}
              value={versionName}
              maxLength={128}
              onChange={(event) => setVersionName(event.target.value)}
            />
          )}
        </FormField>
        <FormField label="Description">
          {(id) => (
            <TextArea
              id={id}
              rows={3}
              value={description}
              maxLength={512}
              onChange={(event) => setDescription(event.target.value)}
            />
          )}
        </FormField>
        <fieldset className="flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1.5 text-sm font-semibold text-ink">
            Reviewers<span className="ml-0.5 text-err">*</span>
          </legend>
          {reviewers.isLoading && <PageLoader label="Loading reviewers" />}
          {reviewers.error && <Callout tone="err">{errorMessage(reviewers.error)}</Callout>}
          {reviewers.data?.length === 0 && (
            <p className="text-sm text-ink-2">No other member can publish this workflow.</p>
          )}
          {reviewers.data?.map((user) => (
            <Checkbox
              key={user.id}
              label={`${user.name} (${user.email})`}
              checked={reviewerIds.includes(user.id)}
              disabled={!reviewerIds.includes(user.id) && reviewerIds.length >= 10}
              onChange={() => toggle(user.id)}
            />
          ))}
        </fieldset>
      </form>
    </Dialog>
  );
}
