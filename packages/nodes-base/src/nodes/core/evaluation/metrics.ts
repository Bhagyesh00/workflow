/**
 * The metrics of the Evaluation node: custom numbers, string similarity, categorization, tools used, and
 * the two AI judged scores. Every function returns a number (or throws an `EvaluationError` with n8n's text);
 * the node turns the error into a node error. Model text is data: it is parsed as JSON and checked, never
 * evaluated, and never put through a template again.
 */
import {
  type AiChatMessage,
  type AiChatModel,
  type DataObject,
  redactSecrets,
  toolNameOf,
} from '@workflow/workflow';
import { similarity } from './levenshtein';
import { fillTemplate, JUDGE_SCHEMA, JUDGE_SYSTEM, JUDGE_USER, type JudgeMetric } from './prompts';

/** an error the node shows as a node error: the text, and an optional second line */
export class EvaluationError extends Error {
  constructor(
    message: string,
    readonly description?: string,
  ) {
    super(message);
    this.name = 'EvaluationError';
  }
}

export const METRIC_NAMES = {
  correctness: 'Correctness',
  helpfulness: 'Helpfulness',
  stringSimilarity: 'String similarity',
  categorization: 'Categorization',
  toolsUsed: 'Tools Used',
} as const;

/** lowest and highest score an AI judge may give */
export const MIN_SCORE = 1;
export const MAX_SCORE = 5;

/** a value as text: text stays, numbers and booleans are written, anything else is JSON */
export function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const isMissing = (value: unknown): boolean => value === undefined || value === null;
const isBlank = (value: unknown): boolean => isMissing(value) || asText(value).trim() === '';

/** 1 - distance / longer length over the trimmed texts; a blank side is missing */
export function stringSimilarityScore(expected: unknown, actual: unknown): number {
  if (isBlank(expected)) throw new EvaluationError('Expected answer is missing');
  if (isBlank(actual)) throw new EvaluationError('Actual answer is missing');
  return similarity(asText(expected).trim(), asText(actual).trim());
}

/** 1 when the trimmed texts are equal, else 0 */
export function categorizationScore(expected: unknown, actual: unknown): number {
  if (isBlank(expected)) throw new EvaluationError('Expected answer is missing');
  if (isBlank(actual)) throw new EvaluationError('Actual answer is missing');
  return asText(expected).trim() === asText(actual).trim() ? 1 : 0;
}

/** the tool name an agent step used, in the form tool names have */
function usedTool(step: unknown): string | undefined {
  const tool = (step as { action?: { tool?: unknown } } | null)?.action?.tool;
  return typeof tool === 'string' && tool ? toolNameOf(tool).toLowerCase() : undefined;
}

/** the share of the expected tools (a comma separated list of node or tool names) the agent's steps used */
export function toolsUsedScore(expectedTools: unknown, steps: unknown): number {
  const expected = [
    ...new Set(
      asText(expectedTools)
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => toolNameOf(name).toLowerCase()),
    ),
  ];
  if (!expected.length) throw new EvaluationError('Expected tool name missing');
  let list: unknown = steps;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      list = undefined;
    }
  }
  if (!Array.isArray(list)) throw new EvaluationError('Intermediate steps missing');
  const used = new Set(list.map(usedTool).filter((name): name is string => !!name));
  return expected.filter((name) => used.has(name)).length / expected.length;
}

interface Assignment {
  name?: string;
  value?: unknown;
  type?: string;
}

/** the custom metrics: every value must be a number, and a metric needs a name */
export function customMetricScores(assignments: Assignment[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of assignments) {
    const name = String(a.name ?? '').trim();
    if (!name) throw new EvaluationError('Metric name missing');
    let value = a.value;
    // a number written in the editor is kept as text in the parameter
    if (a.type === 'number' && typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      value = Number(value);
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new EvaluationError(`Value for '${name}' isn't a number`);
    }
    out[name] = value;
  }
  return out;
}

function textOf(message: AiChatMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** the score of a judge reply: JSON with a whole `score` from 1 to 5 */
export function parseJudgeScore(reply: string): number {
  let text = reply.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced) text = fenced[1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The reply is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The reply is not a JSON object');
  }
  const score = (parsed as DataObject).score;
  if (typeof score !== 'number' || !Number.isInteger(score))
    throw new Error('The score is not a whole number');
  if (score < MIN_SCORE || score > MAX_SCORE) {
    throw new Error(`The score ${score} is not between ${MIN_SCORE} and ${MAX_SCORE}`);
  }
  return score;
}

export interface JudgeInput {
  metric: JudgeMetric;
  model: AiChatModel | undefined;
  actualAnswer: unknown;
  expectedAnswer?: unknown;
  userQuery?: unknown;
  /** the user's own prompt, with placeholders; the built in prompt when blank */
  inputPrompt?: unknown;
  signal?: AbortSignal;
}

/** one judged score, 1 to 5 */
export async function judgeScore(input: JudgeInput): Promise<number> {
  const { metric, model } = input;
  const label = metric === 'correctness' ? 'correctness' : 'helpfulness';
  if (metric === 'correctness') {
    if (isBlank(input.expectedAnswer)) throw new EvaluationError('Expected answer is missing');
    if (isBlank(input.actualAnswer)) throw new EvaluationError('Actual answer is missing');
  } else {
    if (isBlank(input.userQuery)) throw new EvaluationError('User query is missing');
    if (isBlank(input.actualAnswer)) throw new EvaluationError('Response is missing');
  }
  if (!model) throw new EvaluationError('No language model connected');
  if (model.completion) throw new EvaluationError('Language model does not support structured output');

  const custom = asText(input.inputPrompt).trim();
  const prompt = fillTemplate(custom || JUDGE_USER[metric], {
    actual_answer: asText(input.actualAnswer),
    expected_answer: asText(input.expectedAnswer),
    user_query: asText(input.userQuery),
  });
  try {
    const response = await model.chat({
      messages: [
        { role: 'system', content: JUDGE_SYSTEM[metric] },
        { role: 'user', content: prompt },
      ],
      responseFormat: { type: 'json', schema: JUDGE_SCHEMA },
      temperature: 0,
      signal: input.signal,
    });
    return parseJudgeScore(textOf(response.message));
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    throw new EvaluationError(`Failed to evaluate ${label}`, `Error from language model: ${message}`);
  }
}
