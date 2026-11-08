/**
 * The stream guard (P5-67, lane L1): n8n's idle and first-output limits (`AI_MODEL_STREAM_IDLE_TIMEOUT_MS`,
 * `AI_MODEL_STREAM_FIRST_OUTPUT_TIMEOUT_MS`), a timer reset on every delta, one silent retry only when no
 * content streamed, then n8n's plain stall text. C0 stub with the final signature.
 */
import type { AiChatModel } from '@workflow/workflow';

export interface ModelGuardOptions {
  /** ms of silence after the first output; 0 disables this limit only */
  idleMs: number;
  /** ms to the first output; 0 or invalid keeps the default, and it is never below `idleMs` */
  firstOutputMs: number;
  /** silent retries while nothing streamed (n8n: 1) */
  stallRetries?: number;
}

/** `model` with both limits applied to `chat` and `stream` */
export function guardModel(_model: AiChatModel, _options: ModelGuardOptions): AiChatModel {
  throw new Error('not implemented (L1)');
}
