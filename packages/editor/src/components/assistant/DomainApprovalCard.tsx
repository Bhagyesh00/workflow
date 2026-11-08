/**
 * P5-73 (L10): a fetch to a new host: full URL and host as text, allow once, allow the domain, allow all, deny.
 *
 * The URL and the host are the server's reading of the stored args and are rendered as text nodes, never as a
 * link or markup, so a person reads exactly where the Assistant wants to go before choosing. Each button sends
 * its own `domain` answer (never the args). The card stays until the server's `confirmation-resolved` event
 * removes it, as the approval card does.
 */
import { Globe } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, errorMessage } from '../../api/client';
import type { AssistantConfirmationOf } from '../../api/types';
import { answerConfirmation } from '../../features/assistant/confirm-actions';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { approvalTimeLeft } from './ApprovalCard';

export interface DomainApprovalCardProps {
  confirmation: AssistantConfirmationOf<'domain'>;
}

type Action = 'allow_once' | 'allow_domain' | 'allow_all' | 'deny';

export function DomainApprovalCard({ confirmation }: DomainApprovalCardProps) {
  const { title, details, expiresAt, requestId, approvalSummary } = confirmation;
  const [busy, setBusy] = useState<Action | null>(null);
  const [sent, setSent] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  const timeLeft = expiresAt ? approvalTimeLeft(expiresAt, now) : null;
  const expired = Boolean(expiresAt) && timeLeft === null;
  const disabled = busy !== null || sent || expired;

  const answer = async (action: Action) => {
    setBusy(action);
    try {
      await answerConfirmation(requestId, { kind: 'domain', action });
      setSent(true);
    } catch (error) {
      const reason =
        error instanceof ApiError && error.status === 404
          ? 'This request is no longer open.'
          : errorMessage(error);
      toast.error("Couldn't send your answer", reason);
    } finally {
      setBusy(null);
    }
  };

  return (
    <fieldset
      aria-label={`Allow reading ${details.host}`}
      className="m-0 flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3"
    >
      <p className="flex min-w-0 items-center gap-2 text-sm font-semibold">
        <Globe size={14} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 break-words">{title}</span>
      </p>

      <dl className="m-0 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-ink-2">Website</dt>
        <dd className="m-0 min-w-0 break-all font-semibold text-ink">{details.host}</dd>
        <dt className="text-ink-2">Page</dt>
        <dd className="m-0 min-w-0 break-all text-ink">{details.url}</dd>
      </dl>
      <p className="text-xs text-ink-2">
        The page is read from the server, without your cookies or sign-in. What it says is treated as data,
        never as instructions.
      </p>

      {approvalSummary && (
        <div className="rounded border border-line px-2 py-1 text-sm">
          <p className="text-xs font-semibold text-ink-2">The Assistant says</p>
          <p className="m-0 whitespace-pre-wrap break-words text-ink-2">{approvalSummary}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={disabled}
          loading={busy === 'allow_once'}
          onClick={() => void answer('allow_once')}
        >
          Allow once
        </Button>
        <Button
          disabled={disabled}
          loading={busy === 'allow_domain'}
          onClick={() => void answer('allow_domain')}
        >
          Allow this website
        </Button>
        <Button disabled={disabled} loading={busy === 'allow_all'} onClick={() => void answer('allow_all')}>
          Allow all websites
        </Button>
        <Button disabled={disabled} loading={busy === 'deny'} onClick={() => void answer('deny')}>
          Deny
        </Button>
        {expiresAt && (
          <span className="text-xs text-ink-2" aria-live="off">
            {expired ? 'This request timed out' : `Expires in ${timeLeft}`}
          </span>
        )}
      </div>
    </fieldset>
  );
}
