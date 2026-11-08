/** P5-63: the questions the planner asks before it plans. Everything shows as text. */
import type { BuilderQuestion } from '@workflow/workflow';
import { useState } from 'react';
import { answerQuestions } from '../../features/builder/plan-actions';
import { useBuilderStore } from '../../stores/builder-store';
import { Button } from '../ui/Button';
import { Checkbox, TextArea } from '../ui/Field';

export interface QuestionsMessageProps {
  questions: BuilderQuestion[];
}

export function QuestionsMessage({ questions }: QuestionsMessageProps) {
  const streaming = useBuilderStore((s) => s.streaming);
  /** single and text: the answer; multi: the picked options, one per line */
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const set = (id: string, value: string) => setAnswers((prev) => ({ ...prev, [id]: value }));
  const picked = (id: string) => (answers[id] ? answers[id].split('\n') : []);
  const ready = questions.some((q) => (answers[q.id] ?? '').trim());

  const submit = () => {
    void answerQuestions(
      questions.map((q) => ({
        id: q.id,
        answer: q.type === 'multi' ? picked(q.id).join(', ') : (answers[q.id] ?? ''),
      })),
    );
  };

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-3"
      aria-label="Questions from the planner"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !streaming) submit();
      }}
    >
      <p className="text-sm font-semibold">A few questions before the plan</p>
      {questions.map((q) => (
        <fieldset key={q.id} className="flex flex-col gap-1.5">
          <legend className="mb-1 text-sm">{q.question}</legend>
          {q.type === 'single' &&
            (q.options ?? []).map((option) => (
              <label key={option} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`q-${q.id}`}
                  className="size-4 accent-[var(--wf-brand)]"
                  checked={answers[q.id] === option}
                  onChange={() => set(q.id, option)}
                />
                <span>{option}</span>
              </label>
            ))}
          {q.type === 'multi' &&
            (q.options ?? []).map((option) => (
              <Checkbox
                key={option}
                label={option}
                checked={picked(q.id).includes(option)}
                onChange={(event) =>
                  set(
                    q.id,
                    (event.target.checked
                      ? [...picked(q.id), option]
                      : picked(q.id).filter((o) => o !== option)
                    ).join('\n'),
                  )
                }
              />
            ))}
          {q.type === 'text' && (
            <TextArea
              rows={2}
              aria-label={q.question}
              maxLength={2000}
              value={answers[q.id] ?? ''}
              onChange={(event) => set(q.id, event.target.value)}
            />
          )}
        </fieldset>
      ))}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" size="sm" disabled={!ready || streaming}>
          Send answers
        </Button>
      </div>
    </form>
  );
}
