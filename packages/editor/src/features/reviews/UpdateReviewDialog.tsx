/** Move an open review request to the workflow's newest saved version (P3-19). */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { errorMessage } from '../../api/client';
import { reviewsApi } from '../../api/endpoints';
import type { WorkflowReviewDTO } from '../../api/types';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { FormField, TextInput } from '../../components/ui/Field';
import { Callout } from '../../components/ui/misc';
import { toast } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';

export function UpdateReviewDialog({
  review,
  onClose,
}: {
  review: WorkflowReviewDTO | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [versionName, setVersionName] = useState('');
  const unsaved = useWorkflowStore((s) => s.dirty && s.meta.id === review?.workflowId);

  useEffect(() => {
    if (review) setVersionName(review.versionName ?? review.workflowName ?? '');
  }, [review]);

  const update = useMutation({
    mutationFn: () =>
      reviewsApi.updateVersion((review as WorkflowReviewDTO).id, { versionName: versionName.trim() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workflow-reviews'] });
      void queryClient.invalidateQueries({ queryKey: ['workflow-review'] });
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
      toast.success('Review updated', 'The request now points to the newest saved version.');
      onClose();
    },
    onError: (error) => toast.error('Could not update the review', errorMessage(error)),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (versionName.trim() && !unsaved) update.mutate();
  };

  return (
    <Dialog
      open={Boolean(review)}
      onClose={onClose}
      title="Update the review"
      description="The request moves to the newest saved version and goes back to the reviewers."
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="update-review-form"
            loading={update.isPending}
            disabled={!versionName.trim() || unsaved}
          >
            Update review
          </Button>
        </>
      }
    >
      <form id="update-review-form" onSubmit={onSubmit} className="flex flex-col gap-4">
        {unsaved && (
          <Callout tone="warn" title="Save your changes first">
            The review covers the saved version, and this workflow has unsaved changes.
          </Callout>
        )}
        <FormField label="Version name" required>
          {(id) => (
            <TextInput
              id={id}
              value={versionName}
              maxLength={128}
              onChange={(event) => setVersionName(event.target.value)}
              data-autofocus
            />
          )}
        </FormField>
      </form>
    </Dialog>
  );
}
