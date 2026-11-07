/**
 * Out-of-band flags on chat messages. The provider-neutral message type has no "tool failed"
 * flag; providers that support one (Anthropic `is_error`) read it from here. Markers never reach
 * memory or run data. A run that waited sets them again from its steps, see `restoreMessages`.
 */
import type { AiChatMessage } from '@workflow/workflow';

const toolErrors = new WeakSet<AiChatMessage>();

export function markToolError(message: AiChatMessage): AiChatMessage {
  toolErrors.add(message);
  return message;
}

export function isToolError(message: AiChatMessage): boolean {
  return toolErrors.has(message);
}

/** the raw content of a message, for what outlives the adapter that made it: an agent's checkpoint */
const rawContents = new WeakMap<AiChatMessage, unknown>();
/** raw content a resumed run read back: any adapter has it on recall, so the sender picks who gets the message */
const restoredContents = new WeakMap<AiChatMessage, unknown>();

export function rawContentOf(message: AiChatMessage): unknown {
  return rawContents.get(message);
}

export function restoreRawContent(message: AiChatMessage, raw: unknown): void {
  rawContents.set(message, raw);
  restoredContents.set(message, raw);
}

export function hasRestoredRawContent(message: AiChatMessage): boolean {
  return restoredContents.has(message);
}

/**
 * Provider-specific raw content of assistant messages (thinking blocks with signatures, Gemini
 * thought signatures). Providers must replay it unchanged on the next request of a tool loop.
 */
export class RawContentCache<T> {
  private readonly byMessage = new WeakMap<AiChatMessage, T>();
  private readonly byToolCall = new Map<string, T>();

  remember(message: AiChatMessage, raw: T): void {
    this.byMessage.set(message, raw);
    rawContents.set(message, raw);
    for (const call of message.toolCalls ?? []) {
      this.byToolCall.set(call.id, raw);
      // a long-lived model object must not grow without bound
      if (this.byToolCall.size > 1000) this.byToolCall.delete(this.byToolCall.keys().next().value as string);
    }
  }

  recall(message: AiChatMessage): T | undefined {
    const direct = this.byMessage.get(message);
    if (direct) return direct;
    const first = message.toolCalls?.[0];
    const byCall = first ? this.byToolCall.get(first.id) : undefined;
    return byCall ?? (restoredContents.get(message) as T | undefined);
  }
}
