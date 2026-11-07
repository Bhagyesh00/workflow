/**
 * Guardrails check runner: the two stages, masking and the result of every check.
 * Preflight (PII, custom regex, secret keys, URLs) is plain code and runs first. Classify stops at a
 * preflight hit, so the model never sees a text that holds a secret or personal data. The input stage
 * (keywords and the model checks) runs only on a text that passed preflight.
 */
import { type AiChatModel, type DataObject, NodeOperationError, type WorkflowNode } from '@workflow/workflow';
import { errorMessage, redactSecrets } from '../../shared/utils';
import { findRegexMatches, matchKeywords } from './keywords';
import { type LlmCheckDef, runLlmCheck } from './llm-checks';
import { detectPii, type Span } from './pii';
import { detectSecrets, type SecretLevel } from './secrets';
import { checkUrls, type UrlOptions } from './urls';

/** most characters one item may hold; a longer text is refused before any check runs */
export const MAX_TEXT_LENGTH = 200_000;

/** `exception.name` of a check whose model answer could not be read */
export const PARSE_CODE = 'AI_OUTPUT_PARSE';

export interface GuardrailConfig {
  keywords?: string[];
  pii?: { entities: string[] };
  secretKeys?: { level: SecretLevel };
  urls?: UrlOptions;
  customRegex?: Array<{ name: string; regex: string }>;
  /** jailbreak, nsfw, topical alignment and custom prompts */
  llm?: LlmCheckDef[];
}

export interface CheckResult {
  name: string;
  triggered: boolean;
  confidenceScore?: number;
  executionFailed?: boolean;
  exception?: { name: string; description: string };
  info: DataObject;
}

export interface CheckRun {
  /** every check that ran, preflight first */
  checks: CheckResult[];
  /** checks that triggered or failed to run */
  failing: CheckResult[];
  /** the text with everything preflight found replaced by its token (sanitize) */
  maskedText: string;
}

function failure(name: string, error: unknown): CheckResult {
  return {
    name,
    triggered: false,
    executionFailed: true,
    exception: {
      name:
        (error as { code?: unknown } | undefined)?.code === PARSE_CODE
          ? PARSE_CODE
          : error instanceof Error
            ? error.name
            : 'Error',
      description: redactSecrets(errorMessage(error)),
    },
    info: {},
  };
}

/**
 * Replaces spans by `<TOKEN>`. Spans that overlap, even in part, are masked as one stretch named after
 * the longest of them, so no part of a found value stays in the text.
 */
export function maskSpans(text: string, spans: Span[]): string {
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let position = 0;
  for (let i = 0; i < ordered.length; ) {
    const start = ordered[i].start;
    let longest = ordered[i];
    let end = longest.end;
    for (i++; i < ordered.length && ordered[i].start < end; i++) {
      const span = ordered[i];
      if (span.end - span.start > longest.end - longest.start) longest = span;
      end = Math.max(end, span.end);
    }
    parts.push(text.slice(position, start), `<${longest.type}>`);
    position = end;
  }
  parts.push(text.slice(position));
  return parts.join('');
}

async function preflight(
  text: string,
  config: GuardrailConfig,
): Promise<{ checks: CheckResult[]; spans: Span[] }> {
  const checks: CheckResult[] = [];
  const spans: Span[] = [];
  // one by one: a text at the cap can hold more spans than a spread call can take
  const addSpans = (found: Span[]) => {
    for (const span of found) spans.push(span);
  };

  if (config.pii) {
    try {
      const found = detectPii(text, config.pii.entities);
      addSpans(found);
      checks.push({
        name: 'pii',
        triggered: found.length > 0,
        info: { analyzerResults: found.map((s) => ({ entityType: s.type, start: s.start, end: s.end })) },
      });
    } catch (error) {
      checks.push(failure('pii', error));
    }
  }

  for (const entry of config.customRegex ?? []) {
    const name = entry.name || 'customRegex';
    try {
      const found = await findRegexMatches(text, entry.regex, name);
      addSpans(found);
      checks.push({
        name,
        triggered: found.length > 0,
        info: { matches: found.length, offsets: found.map((s) => ({ start: s.start, end: s.end })) },
      });
    } catch (error) {
      checks.push(failure(name, error));
    }
  }

  if (config.secretKeys) {
    try {
      const found = detectSecrets(text, config.secretKeys.level);
      addSpans(found);
      checks.push({
        name: 'secretKeys',
        triggered: found.length > 0,
        info: { detectedSecrets: found.length },
      });
    } catch (error) {
      checks.push(failure('secretKeys', error));
    }
  }

  if (config.urls) {
    try {
      const result = checkUrls(text, config.urls);
      addSpans(result.blocked);
      checks.push({
        name: 'urls',
        triggered: result.blocked.length > 0,
        info: {
          detected: result.detected,
          allowed: result.allowed,
          blocked: result.blocked.length,
          blockedReasons: result.blockedReasons,
        },
      });
    } catch (error) {
      checks.push(failure('urls', error));
    }
  }
  return { checks, spans };
}

const isFailing = (check: CheckResult) => check.triggered || check.executionFailed === true;

export async function runChecks(args: {
  text: string;
  operation: 'classify' | 'sanitize';
  config: GuardrailConfig;
  /** asked for only when a model check has to run */
  getModel: () => Promise<AiChatModel>;
  systemRules: string;
  context: { node: WorkflowNode; itemIndex: number; signal?: AbortSignal };
}): Promise<CheckRun> {
  const { text, operation, config, context } = args;
  if (text.length > MAX_TEXT_LENGTH) {
    throw new NodeOperationError(context.node, 'The text is too long to check', {
      itemIndex: context.itemIndex,
      description: `Texts above ${MAX_TEXT_LENGTH.toLocaleString('en-US')} characters are not checked`,
    });
  }

  const early = await preflight(text, config);
  const maskedText = maskSpans(text, early.spans);
  if (operation === 'sanitize') {
    return { checks: early.checks, failing: early.checks.filter((c) => c.executionFailed), maskedText };
  }
  // a hit stops classify here: the model is never asked about a text with a secret or personal data in it
  if (early.checks.some(isFailing)) {
    return { checks: early.checks, failing: early.checks.filter(isFailing), maskedText };
  }

  const checks = [...early.checks];
  if (config.keywords?.length) {
    try {
      const matched = matchKeywords(text, config.keywords);
      checks.push({ name: 'keywords', triggered: matched.length > 0, info: { matchedKeywords: matched } });
    } catch (error) {
      checks.push(failure('keywords', error));
    }
  }

  const llm = config.llm ?? [];
  if (llm.length) {
    let model: AiChatModel | undefined;
    let modelError: unknown;
    try {
      model = await args.getModel();
    } catch (error) {
      if (error instanceof NodeOperationError) throw error;
      modelError = error;
    }
    const results = await Promise.all(
      llm.map(async (def): Promise<CheckResult> => {
        if (!model) return failure(def.name, modelError);
        try {
          const verdict = await runLlmCheck(model, def, text, args.systemRules, context);
          return {
            name: def.name,
            triggered: verdict.triggered,
            confidenceScore: verdict.confidenceScore,
            info: { flagged: verdict.flagged, threshold: def.threshold },
          };
        } catch (error) {
          return failure(def.name, error);
        }
      }),
    );
    checks.push(...results);
  }
  return { checks, failing: checks.filter(isFailing), maskedText };
}
