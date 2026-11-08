/**
 * P5-69 (L6): `ask_user`'s questions (single, multi, text), answered or dismissed.
 *
 * Each question is answered or skipped; Send is on once every question is one or the other. A skipped question
 * goes to the server with no answer (it grants nothing). Dismiss answers none of them. The questions, options and
 * intro are the Assistant's words and render as text nodes only. The card stays until the server's
 * `confirmation-resolved` event removes it.
 */
import { MessageCircle } from 'lucide-react';
import { useId, useState } from 'react';
import { ApiError, errorMessage } from '../../api/client';
import type { AssistantConfirmationOf } from '../../api/types';
import { answerConfirmation } from '../../features/assistant/confirm-actions';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { Checkbox, TextArea } from '../ui/Field';

export interface QuestionsCardProps {
  confirmation: AssistantConfirmationOf<'questions'>;
}

interface Draft {
  /** single and text */
  value: string;
  /** multi */
  picked: string[];
  skipped: boolean;
}

const EMPTY: Draft = { value: '', picked: [], skipped: false };

export function QuestionsCard({ confirmation }: QuestionsCardProps) {
  const { requestId, title, details, expiresAt } = confirmation;
  const questions = details?.questions ?? [];
  const groupId = useId();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<'send' | 'dismiss' | null>(null);
  const [sent, setSent] = useState(false);
  const expired = expiresAt !== null && Date.parse(expiresAt) <= Date.now();

  const draft = (id: string) => drafts[id] ?? EMPTY;
  const update = (id: string, patch: Partial<Draft>) =>
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY), ...patch } }));
  const answered = (id: string, type: string) => {
    const d = draft(id);
    return type === 'multi' ? d.picked.length > 0 : d.value.trim().length > 0;
  };
  const ready = questions.length > 0 && questions.every((q) => draft(q.id).skipped || answered(q.id, q.type));
  const disabled = busy !== null || sent || expired;

  const send = async (kind: 'send' | 'dismiss') => {
    setBusy(kind);
    try {
      await answerConfirmation(
        requestId,
        kind === 'dismiss'
          ? { kind: 'questions', answers: [], dismissed: true }
          : {
              kind: 'questions',
              answers: questions.map((q) => {
                const d = draft(q.id);
                if (d.skipped) return { id: q.id, answer: null };
                return { id: q.id, answer: q.type === 'multi' ? d.picked : d.value.trim() };
              }),
            },
      );
      setSent(true);
    } catch (error) {
      const reason =
        error instanceof ApiError && error.status === 404
          ? 'This request is no longer open.'
          : errorMessage(error);
      toast.error("Couldn't send your answers", reason);
    } finally {
      setBusy(null);
    }
  };

  return (
    <form
      aria-label={`Questions: ${title}`}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface-2 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !disabled) void send('send');
      }}
    >
      <p className="flex min-w-0 items-center gap-2 text-sm font-semibold">
        <MessageCircle size={14} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 break-words">{title}</span>
      </p>
      {details?.introMessage ? (
        <p className="m-0 whitespace-pre-wrap break-words text-sm text-ink-2">{details.introMessage}</p>
      ) : null}

      {questions.map((q, index) => {
        const d = draft(q.id);
        const off = disabled || d.skipped;
        const name = `${groupId}-${index}`;
        return (
          <fieldset
            key={q.id}
            className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"
            data-question-id={q.id}
          >
            <legend className="mb-1 break-words text-sm text-ink">{q.question}</legend>
            {q.type === 'single' &&
              (q.options ?? []).map((option) => (
                <label key={option} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={name}
                    className="size-4 accent-[var(--wf-brand)]"
                    disabled={off}
                    checked={d.value === option}
                    onChange={() => update(q.id, { value: option })}
                  />
                  <span className="break-words">{option}</span>
                </label>
              ))}
            {q.type === 'multi' &&
              (q.options ?? []).map((option) => (
                <Checkbox
                  key={option}
                  label={option}
                  disabled={off}
                  checked={d.picked.includes(option)}
                  onChange={(event) =>
                    update(q.id, {
                      picked: event.target.checked
                        ? [...d.picked, option]
                        : d.picked.filter((picked) => picked !== option),
                    })
                  }
                />
              ))}
            {q.type === 'text' && (
              <TextArea
                rows={2}
                aria-label={q.question}
                maxLength={2000}
                disabled={off}
                value={d.value}
                onChange={(event) => update(q.id, { value: event.target.value })}
              />
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-pressed={d.skipped}
                disabled={disabled}
                onClick={() => update(q.id, { skipped: !d.skipped })}
                className="rounded-md px-1.5 py-0.5 text-2xs font-semibold text-ink-2 hover:bg-surface-3 hover:text-ink aria-pressed:bg-brand-soft aria-pressed:text-brand disabled:opacity-50"
              >
                {d.skipped ? 'Answer this' : 'Skip'}
              </button>
              {d.skipped ? <span className="text-xs text-ink-3">Skipped: no answer is sent</span> : null}
            </div>
          </fieldset>
        );
      })}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={disabled || !ready} loading={busy === 'send'}>
          Send answers
        </Button>
        <Button disabled={disabled} loading={busy === 'dismiss'} onClick={() => void send('dismiss')}>
          Dismiss
        </Button>
        {expired && <span className="text-xs text-ink-2">This request timed out</span>}
      </div>
    </form>
  );
}
