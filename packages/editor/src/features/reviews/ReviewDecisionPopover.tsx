/** Approve or request changes on an open review request (P3-19). */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { errorMessage } from '../../api/client';
import { reviewsApi } from '../../api/endpoints';
import type { ReviewDecisionBody, WorkflowReviewDTO } from '../../api/types';
import { Button } from '../../components/ui/Button';
import { FormField, TextArea } from '../../components/ui/Field';
import { toast } from '../../stores/ui-store';

/** control characters other than tab, newline and carriage return are refused (as the server does) */
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
  }
  return false;
}

export function ReviewDecisionPopover({ review }: { review: WorkflowReviewDTO }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<ReviewDecisionBody['decision']>('approved');
  const [note, setNote] = useState('');

  const decide = useMutation({
    mutationFn: () => reviewsApi.decide(review.id, { decision, note: note.trim() || undefined }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['workflow-reviews'] });
      void queryClient.invalidateQueries({ queryKey: ['workflow-review'] });
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
      void queryClient.invalidateQueries({ queryKey: ['workflow'] });
      setOpen(false);
      setNote('');
      setDecision('approved');
      if (decision === 'changes_requested') {
        toast.success('Changes requested', 'The author can send a new version.');
      } else if (result.autoPublish?.status === 'failed') {
        toast.error(
          'Approved, but the workflow was not published',
          result.autoPublish.message ?? 'Publishing failed.',
        );
      } else {
        toast.success('Approved and published');
      }
    },
    onError: (error) => toast.error('Could not save the decision', errorMessage(error)),
  });

  const noteError =
    decision === 'changes_requested' && !note.trim()
      ? 'Say what needs to change.'
      : hasControlChars(note)
        ? 'The note has characters that are not allowed.'
        : undefined;
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!noteError) decide.mutate();
  };

  return (
    <div className="relative">
      <Button
        variant="primary"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        Review
      </Button>
      {open && (
        <form
          aria-label="Your decision"
          onSubmit={onSubmit}
          className="absolute right-0 z-20 mt-2 flex w-80 flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-card"
        >
          <fieldset className="flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1 text-sm font-semibold text-ink">Your decision</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="review-decision"
                className="accent-[var(--wf-brand)]"
                checked={decision === 'approved'}
                onChange={() => setDecision('approved')}
              />
              Approve and publish
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="review-decision"
                className="accent-[var(--wf-brand)]"
                checked={decision === 'changes_requested'}
                onChange={() => setDecision('changes_requested')}
              />
              Request changes
            </label>
          </fieldset>
          <FormField
            label="Note"
            required={decision === 'changes_requested'}
            error={note.length > 0 || decision === 'approved' ? noteError : undefined}
          >
            {(id) => (
              <TextArea
                id={id}
                rows={3}
                maxLength={10000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            )}
          </FormField>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={decide.isPending} disabled={Boolean(noteError)}>
              Send decision
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
