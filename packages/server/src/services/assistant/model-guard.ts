/**
 * The stream guard (P5-67, lane L1): n8n's idle and first-output limits (`AI_MODEL_STREAM_IDLE_TIMEOUT_MS`,
 * `AI_MODEL_STREAM_FIRST_OUTPUT_TIMEOUT_MS`), a timer reset on every delta, one silent retry only when no
 * content streamed, then a plain stall text.
 *
 * As n8n's runtime clamps them: the first-output limit is never below the idle limit
 * (`firstOutputMs = max(first, idle)`), a first-output value of 0 or one that is not a positive number
 * keeps its default, and an idle value of 0 disables the idle limit only. A model that cannot stream gets
 * the first-output limit for the whole call.
 */
import {
  type AiChatModel,
  type AiChatRequest,
  type AiChatResponse,
  ASSISTANT_STREAM,
} from '@workflow/workflow';

export interface ModelGuardOptions {
  /** ms of silence after the first output; 0 disables this limit only */
  idleMs: number;
  /** ms to the first output; 0 or invalid keeps the default, and it is never below `idleMs` */
  firstOutputMs: number;
  /** silent retries while nothing streamed (n8n: 1) */
  stallRetries?: number;
}

/** what the person reads when the model went silent */
export const ASSISTANT_STALL_TEXT = 'The AI model stopped responding. Try again in a moment.';

/** the limits after n8n's clamping: `idleMs` 0 means no idle limit */
export function streamLimits(options: ModelGuardOptions): {
  idleMs: number;
  firstOutputMs: number;
  retries: number;
} {
  const idleMs = Number.isFinite(options.idleMs) && options.idleMs > 0 ? options.idleMs : 0;
  const first =
    Number.isFinite(options.firstOutputMs) && options.firstOutputMs > 0
      ? options.firstOutputMs
      : ASSISTANT_STREAM.firstOutputMs;
  const retries =
    options.stallRetries !== undefined && Number.isInteger(options.stallRetries) && options.stallRetries >= 0
      ? options.stallRetries
      : ASSISTANT_STREAM.stallRetries;
  return { idleMs, firstOutputMs: Math.max(first, idleMs), retries };
}

class StallError extends Error {
  override name = 'AssistantModelStall';
  constructor() {
    super(ASSISTANT_STALL_TEXT);
  }
}

/** `model` with both limits applied to `chat` and `stream` */
export function guardModel(model: AiChatModel, options: ModelGuardOptions): AiChatModel {
  const limits = streamLimits(options);

  /** one attempt: `work` gets the joined signal and a `touch` that resets the timer to the idle limit */
  const attempt = async (
    request: AiChatRequest,
    work: (signal: AbortSignal, touch: (content: boolean) => void) => Promise<AiChatResponse>,
  ): Promise<{ response?: AiChatResponse; stalled: boolean; streamed: boolean }> => {
    const local = new AbortController();
    const signal = request.signal ? AbortSignal.any([request.signal, local.signal]) : local.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let streamed = false;
    const arm = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (ms > 0) timer = setTimeout(() => local.abort(new StallError()), ms);
    };
    // every delta resets the timer: the idle limit once content came, the first-output limit before
    const touch = (content: boolean) => {
      if (content) streamed = true;
      arm(streamed ? limits.idleMs : limits.firstOutputMs);
    };
    arm(limits.firstOutputMs);
    try {
      // the timer fires as an abort; the race makes it end a call that does not watch its signal
      const stalled = new Promise<never>((_, reject) => {
        local.signal.addEventListener('abort', () => reject(local.signal.reason), { once: true });
      });
      stalled.catch(() => {});
      const response = await Promise.race([work(signal, touch), stalled]);
      return { response, stalled: false, streamed };
    } catch (error) {
      if (request.signal?.aborted) throw error;
      if (local.signal.aborted && local.signal.reason instanceof StallError) {
        return { stalled: true, streamed };
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const guarded = async (
    request: AiChatRequest,
    work: (signal: AbortSignal, touch: (content: boolean) => void) => Promise<AiChatResponse>,
  ): Promise<AiChatResponse> => {
    let retries = limits.retries;
    for (;;) {
      const outcome = await attempt(request, work);
      if (outcome.response) return outcome.response;
      // a retry only while nothing reached the person: streamed text cannot be taken back
      if (outcome.streamed || retries <= 0) throw new StallError();
      retries--;
    }
  };

  const wrapped: AiChatModel = {
    kind: 'chatModel',
    provider: model.provider,
    model: model.model,
    ...(model.completion !== undefined ? { completion: model.completion } : {}),
    ...(model.nodeName !== undefined ? { nodeName: model.nodeName } : {}),
    chat: (request) =>
      guarded(request, (signal) => {
        // a call that streams nothing: only the first-output limit applies
        return model.chat({ ...request, signal });
      }),
  };
  if (model.stream) {
    const stream = model.stream.bind(model);
    wrapped.stream = (request, onDelta) =>
      guarded(request, (signal, touch) =>
        stream({ ...request, signal }, (delta) => {
          touch(Boolean(delta));
          onDelta(delta);
        }),
      );
  }
  return wrapped;
}

/** true when `error` is the guard's stall */
export function isModelStall(error: unknown): boolean {
  return error instanceof StallError;
}
