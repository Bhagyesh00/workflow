/** "Publish" or "Submit for review" question that Publish asks while workflow reviews are on (P3-19). */
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Checkbox } from '../../components/ui/Field';
import { useReviewUi } from './review-publish';

export function PublishChoiceDialog() {
  const choice = useReviewUi((s) => s.choice);
  const [remember, setRemember] = useState(false);
  const settle = (value: 'publish' | 'review' | null) => {
    choice?.settle(value, remember);
    setRemember(false);
  };
  return (
    <Dialog
      open={Boolean(choice)}
      onClose={() => settle(null)}
      title="Publish or ask for a review?"
      description="Your workspace asks for a review before a workflow goes live."
      size="sm"
      footer={
        <>
          <Button onClick={() => settle(null)}>Cancel</Button>
          <Button onClick={() => settle('publish')}>Publish</Button>
          <Button variant="primary" onClick={() => settle('review')} data-autofocus>
            Submit for review
          </Button>
        </>
      }
    >
      <Checkbox
        label="Don't ask again"
        checked={remember}
        onChange={(event) => setRemember(event.target.checked)}
      />
    </Dialog>
  );
}
