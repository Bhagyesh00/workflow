/**
 * P5-68 (L3): approve or deny one write: title with the resource name, plain facts, previews with omitted counts,
 * Always allow this session (only when `allowSession`), countdown; values as text.
 *
 * Every value (facts, preview cells, the model's summary) is rendered as a text node, never as markup. The facts
 * are the server's reading of the stored args; the model's own words (`approvalSummary`) sit apart, labelled as
 * the Assistant's. The card stays until the server's `confirmation-resolved` event removes it, so a second tab
 * shows the same outcome.
 */
import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, errorMessage } from '../../api/client';
import type { AssistantConfirmationOf } from '../../api/types';
import { answerConfirmation } from '../../features/assistant/confirm-actions';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';

export interface ApprovalCardProps {
  confirmation: AssistantConfirmationOf<'approval'>;
}

type Choice = 'approve' | 'session' | 'deny';

/** the time left on a card as text (`23 h 59 min`, `4 min`, `12 s`); null when it has run out */
export function approvalTimeLeft(expiresAt: string, now: number = Date.now()): string | null {
  const left = Date.parse(expiresAt) - now;
  if (!Number.isFinite(left) || left <= 0) return null;
  const seconds = Math.ceil(left / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** the countdown, ticking every second while a timeout is set */
function useTimeLeft(expiresAt: string | null): { text: string | null; expired: boolean } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt) return { text: null, expired: false };
  const text = approvalTimeLeft(expiresAt, now);
  return { text, expired: text === null };
}

const plural = (count: number, one: string) => `${count} more ${one}${count === 1 ? '' : 's'}`;

export function ApprovalCard({ confirmation }: ApprovalCardProps) {
  const { title, resourceName, approvalSummary, allowSession, details, expiresAt, requestId } = confirmation;
  const [busy, setBusy] = useState<Choice | null>(null);
  const [sent, setSent] = useState(false);
  const { text: timeLeft, expired } = useTimeLeft(expiresAt);
  const preview = details?.preview;
  // facts, columns and cells have no id: they are keyed by position, fixed for the card's life
  const facts = (details?.facts ?? []).map((fact, at) => ({ ...fact, key: `fact-${at}` }));
  const table = preview && {
    columns: preview.columns.map((text, at) => ({ text, key: `column-${at}` })),
    rows: preview.rows.map((row, at) => ({
      key: `row-${at}`,
      cells: row.map((text, cell) => ({ text, key: `cell-${at}-${cell}` })),
    })),
  };
  const disabled = busy !== null || sent || expired;

  const answer = async (choice: Choice) => {
    setBusy(choice);
    try {
      await answerConfirmation(
        requestId,
        choice === 'deny'
          ? { kind: 'approval', approved: false }
          : { kind: 'approval', approved: true, scope: choice === 'session' ? 'session' : 'once' },
      );
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

  const heading = resourceName ? `${title}: ${resourceName}` : title;
  return (
    <fieldset
      aria-label={`Approve ${heading}`}
      className="m-0 flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3"
    >
      <p className="flex min-w-0 items-center gap-2 text-sm font-semibold">
        <ShieldCheck size={14} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 break-words">
          {title}
          {resourceName ? (
            <>
              {': '}
              <strong className="font-semibold text-ink">{resourceName}</strong>
            </>
          ) : null}
        </span>
      </p>

      {facts.length > 0 && (
        <dl className="m-0 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          {facts.map((fact) => (
            <div key={fact.key} className="contents">
              <dt className="text-ink-2">{fact.label}</dt>
              <dd className="m-0 min-w-0 break-words text-ink">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {table && (table.columns.length > 0 || table.rows.length > 0) && (
        <div className="min-w-0 overflow-x-auto rounded border border-line">
          <table className="w-full border-collapse text-left text-xs" aria-label="Preview">
            <thead>
              <tr>
                {table.columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className="border-b border-line px-2 py-1 font-semibold text-ink-2"
                  >
                    {column.text}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr key={row.key}>
                  {row.cells.map((cell) => (
                    <td
                      key={cell.key}
                      className="max-w-[16rem] truncate border-b border-line px-2 py-1"
                      title={cell.text}
                    >
                      {cell.text}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {preview && (preview.omittedRows > 0 || preview.omittedColumns > 0) && (
        <p className="text-xs text-ink-2">
          {[
            preview.omittedRows > 0 ? plural(preview.omittedRows, 'row') : null,
            preview.omittedColumns > 0 ? plural(preview.omittedColumns, 'column') : null,
          ]
            .filter(Boolean)
            .join(', ')}{' '}
          not shown
        </p>
      )}

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
          loading={busy === 'approve'}
          onClick={() => void answer('approve')}
        >
          Approve
        </Button>
        {allowSession && (
          <Button disabled={disabled} loading={busy === 'session'} onClick={() => void answer('session')}>
            Always allow this session
          </Button>
        )}
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
