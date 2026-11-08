/** P5-63: answers to the planner's questions and the decision on a plan, sent as `resumeData`. Stubs until L3. */

export async function answerQuestions(_answers: Array<{ id: string; answer: string }>): Promise<void> {
  throw new Error('not implemented (L3)');
}

export async function decidePlan(
  _decision: 'approve' | 'modify' | 'reject',
  _feedback?: string,
): Promise<void> {
  throw new Error('not implemented (L3)');
}
