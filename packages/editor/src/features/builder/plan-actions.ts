/**
 * P5-63: answers to the planner's questions and the decision on a plan, sent as `resumeData`. The server
 * reads the questions or the plan back from the session, so only the answers or the decision travel.
 */
import { BUILDER_PROMPT_LIMIT } from '@workflow/workflow';
import { useBuilderStore } from '../../stores/builder-store';

/** the answers as chat text (shown as the user's message), or '' when they would not fit one prompt */
function answersText(answers: Array<{ id: string; answer: string }>): string {
  const questions = useBuilderStore.getState().questions ?? [];
  const text = answers
    .map(({ id, answer }) => {
      const question = questions.find((q) => q.id === id)?.question;
      return question ? `${question}\n${answer}` : answer;
    })
    .join('\n\n');
  return text.length > BUILDER_PROMPT_LIMIT ? '' : text;
}

/** sends the answers; the planner continues in plan mode */
export async function answerQuestions(answers: Array<{ id: string; answer: string }>): Promise<void> {
  const cleaned = answers
    .map(({ id, answer }) => ({ id, answer: answer.trim() }))
    .filter(({ answer }) => answer);
  if (cleaned.length === 0) return;
  await useBuilderStore.getState().send(answersText(cleaned), { resumeData: { answers: cleaned } });
}

/**
 * Approve builds the plan (the mode moves to build), Modify plans again with the feedback, Reject ends
 * the plan. The feedback of a modify also shows as the user's message.
 */
export async function decidePlan(
  decision: 'approve' | 'modify' | 'reject',
  feedback?: string,
): Promise<void> {
  const store = useBuilderStore.getState();
  if (store.streaming) return;
  const note = feedback?.trim() ?? '';
  if (decision === 'modify' && !note) return;
  if (decision === 'approve') store.setMode('build');
  await store.send(decision === 'modify' ? note : '', {
    resumeData: { planDecision: decision, ...(decision === 'modify' ? { feedback: note } : {}) },
  });
}
