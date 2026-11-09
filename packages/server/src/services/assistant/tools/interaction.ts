/**
 * Assistant tools: questions to the person, the task checklist and credential setup (P5-69, lane L6).
 *
 * - `ask_user` (viewer): a questions card (`single`, `multi`, `text`); a question without an id gets the
 *   first free `q1`, `q2`, ...; two questions with one id are refused before any card. The answer resumes
 *   the call with `{ answered: true, answers }`; a dismissal, no answers or only skipped answers give
 *   `{ answered: false }`. A skipped question grants nothing.
 * - `update_tasks` (viewer): saves the checklist on the thread, sends `tasks-update`, returns `{ saved: true }`.
 * - `setup_credentials` (editor, `createCredential`): a credential card for one type; the person picks or
 *   creates the credential in the editor's own dialog. `resume` checks the id is a credential of this
 *   workspace and of that type and gives the model its id, name and type only: never its data.
 */
import {
  type AssistantConfirmAnswer,
  type AssistantQuestion,
  type AssistantTask,
  redactSecrets,
} from '@workflow/workflow';
import { z } from 'zod';
import { type AssistantToolDefinition, assertScope } from '../types';

const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 20;
const MAX_ANSWER_CHARS = 2000;
const MAX_TASKS = 50;

// ---------------------------------------------------------------------------------------------------------
// ask_user
// ---------------------------------------------------------------------------------------------------------

const questionInput = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe('Question id; left out, the questions get q1, q2, ... in order'),
    question: z.string().trim().min(1).max(1000).describe('The question as the person reads it'),
    type: z
      .enum(['single', 'multi', 'text'])
      .describe('single: pick one option; multi: pick any number; text: a free answer'),
    options: z
      .array(z.string().trim().min(1).max(200))
      .max(MAX_OPTIONS)
      .optional()
      .describe('The choices, needed for single and multi; not used for text'),
  })
  .superRefine((value, issue) => {
    if (value.type !== 'text' && !value.options?.length) {
      issue.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'A single or multi question needs options',
      });
    }
  });

const askUserInput = z.object({
  questions: z.array(questionInput).min(1).max(MAX_QUESTIONS),
  introMessage: z.string().trim().max(1000).optional().describe('A short line shown above the questions'),
});
type AskUserInput = z.infer<typeof askUserInput>;

/** the questions with their ids: given ones kept, the others get the first free `q<n>` */
export function questionsWithIds(questions: AskUserInput['questions']): AssistantQuestion[] {
  const given = questions.map((q) => q.id).filter((id): id is string => id !== undefined);
  const used = new Set(given);
  if (used.size !== given.length) throw new Error('Each question needs its own id; two questions share one');
  return questions.map((q, index) => {
    let id = q.id;
    if (!id) {
      let n = index + 1;
      while (used.has(`q${n}`)) n++;
      id = `q${n}`;
      used.add(id);
    }
    return {
      id,
      question: q.question,
      type: q.type,
      ...(q.type !== 'text' && q.options ? { options: q.options } : {}),
    };
  });
}

/** one answer as the model reads it; null when the person skipped the question */
function answerValue(question: AssistantQuestion, raw: unknown): string | string[] | null {
  const text = (value: unknown) =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value).trim().slice(0, MAX_ANSWER_CHARS)
      : '';
  if (question.type === 'multi') {
    const list = (Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw])
      .map(text)
      .filter(Boolean)
      .slice(0, MAX_OPTIONS);
    return list.length ? list : null;
  }
  const value = text(Array.isArray(raw) ? raw[0] : raw);
  return value ? value : null;
}

interface QuestionAnswer {
  questionId: string;
  question: string;
  answer: string | string[] | null;
  skipped?: true;
}

export function questionsResult(
  questions: AssistantQuestion[],
  answer: AssistantConfirmAnswer,
): { answered: false } | { answered: true; answers: QuestionAnswer[]; note?: string } {
  if (answer.kind !== 'questions' || answer.dismissed || !answer.answers?.length) return { answered: false };
  const given = new Map<string, unknown>();
  for (const entry of answer.answers) {
    if (entry && typeof entry.id === 'string' && !given.has(entry.id)) given.set(entry.id, entry.answer);
  }
  const answers: QuestionAnswer[] = questions.map((question) => {
    const value = answerValue(question, given.get(question.id));
    return value === null
      ? { questionId: question.id, question: question.question, answer: null, skipped: true }
      : { questionId: question.id, question: question.question, answer: value };
  });
  if (answers.every((a) => a.skipped)) return { answered: false };
  return answers.some((a) => a.skipped)
    ? {
        answered: true,
        answers,
        note: 'A skipped question has no answer and is not a yes to anything. Pick a safe default for it and do not ask it again.',
      }
    : { answered: true, answers };
}

const askUser: AssistantToolDefinition<AskUserInput> = {
  name: 'ask_user',
  description:
    'Ask the person one or more questions when only they can decide (a choice between options, a name, a missing detail). The turn waits for their answers. A skipped or dismissed question is not permission for anything.',
  input: askUserInput,
  access: 'instanceAi:message',
  async suspendFor(_ctx, _run, input) {
    const questions = questionsWithIds(input.questions);
    return {
      inputType: 'questions',
      title: questions.length === 1 ? 'A question for you' : 'A few questions for you',
      details: { ...(input.introMessage ? { introMessage: input.introMessage } : {}), questions },
      grantKey: null,
    };
  },
  async resume(_ctx, _run, input, answer) {
    return questionsResult(questionsWithIds(input.questions), answer);
  },
  async handler() {
    // never reached: `suspendFor` always shows the card and the answer runs `resume`
    return { answered: false };
  },
};

// ---------------------------------------------------------------------------------------------------------
// update_tasks
// ---------------------------------------------------------------------------------------------------------

const taskInput = z.object({
  id: z.string().trim().min(1).max(64),
  description: z
    .string()
    .trim()
    .min(1, 'A task needs a description: it is the text the person sees')
    .max(300),
  status: z.enum(['todo', 'in_progress', 'done', 'failed', 'cancelled']),
  detail: z.string().trim().max(500).optional(),
});

const updateTasksInput = z.object({
  tasks: z
    .array(taskInput)
    .max(MAX_TASKS)
    .superRefine((tasks, issue) => {
      const ids = new Set<string>();
      for (const task of tasks) {
        if (ids.has(task.id))
          issue.addIssue({ code: 'custom', message: `Task id "${task.id}" is used twice` });
        ids.add(task.id);
      }
    })
    .describe('The whole checklist in order; it replaces the previous one'),
});
type UpdateTasksInput = z.infer<typeof updateTasksInput>;

const updateTasks: AssistantToolDefinition<UpdateTasksInput> = {
  name: 'update_tasks',
  description:
    'Show the person a checklist of the steps of the current work and their status. Send the whole list each time; it replaces the last one.',
  input: updateTasksInput,
  access: 'instanceAi:message',
  async handler(ctx, run, input) {
    const tasks: AssistantTask[] = input.tasks.map((task) => ({
      id: task.id,
      description: task.description,
      status: task.status,
      ...(task.detail ? { detail: task.detail } : {}),
    }));
    await ctx.repos.assistantThreads.setTasks(run.tenant.id, run.threadId, tasks);
    run.emit({ type: 'tasks-update', runId: run.runId, payload: { tasks } });
    return { saved: true };
  },
};

// ---------------------------------------------------------------------------------------------------------
// setup_credentials
// ---------------------------------------------------------------------------------------------------------

const setupCredentialsInput = z.object({
  credentialType: z.string().trim().min(1).max(128).describe('The credential type name, e.g. "slackApi"'),
  reason: z.string().trim().max(500).optional().describe('Why the credential is needed, shown on the card'),
});
type SetupCredentialsInput = z.infer<typeof setupCredentialsInput>;

const setupCredentials: AssistantToolDefinition<SetupCredentialsInput> = {
  name: 'setup_credentials',
  description:
    'Ask the person to pick or create a credential of one type in the editor. You never see its secret values; the result is its id, name and type, or that none was picked.',
  input: setupCredentialsInput,
  access: 'credential:create',
  permission: 'createCredential',
  // the credential name is workspace text, written by any member
  untrusted: 'credential',
  async suspendFor(ctx, _run, input) {
    const type = ctx.registries.credentialTypes.get(input.credentialType);
    if (!type) throw new Error(`There is no credential type "${input.credentialType}"`);
    return {
      inputType: 'credential',
      title: 'Set up a credential',
      resourceName: type.displayName,
      details: {
        credentialType: type.name,
        displayName: type.displayName,
        ...(input.reason ? { reason: input.reason } : {}),
      },
      grantKey: null,
    };
  },
  async resume(ctx, run, input, answer) {
    if (answer.kind !== 'credential' || !answer.credentialId) {
      return {
        completed: false,
        credentialType: input.credentialType,
        message: 'The person did not pick a credential',
      };
    }
    const row = await ctx.repos.credentials.get(run.tenant.id, answer.credentialId);
    if (!row || row.tenantId !== run.tenant.id || row.type !== input.credentialType) {
      throw new Error(
        `The picked credential is not a "${input.credentialType}" credential of this workspace`,
      );
    }
    // the id comes from the person's answer: it must be a credential they may read, or it is not theirs to name
    await assertScope(ctx, run, 'credential:read', { credentialId: row.id });
    return { completed: true, credential: { id: row.id, name: redactSecrets(row.name), type: row.type } };
  },
  async handler(_ctx, _run, input) {
    // never reached: `suspendFor` always shows the card and the answer runs `resume`
    return { completed: false, credentialType: input.credentialType };
  },
};

export const interactionTools: AssistantToolDefinition[] = [askUser, updateTasks, setupCredentials];
