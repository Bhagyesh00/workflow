/**
 * Out-of-band flags on chat messages. The provider-neutral message type has no "tool failed"
 * flag; providers that support one (Anthropic `is_error`) read it from here. Markers live only
 * for the run that created the message and never reach memory or run data.
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

/**
 * Provider-specific raw content of assistant messages (thinking blocks with signatures, Gemini
 * thought signatures). Providers must replay it unchanged on the next request of a tool loop.
 */
export class RawContentCache<T> {
  private readonly byMessage = new WeakMap<AiChatMessage, T>();
  private readonly byToolCall = new Map<string, T>();

  remember(message: AiChatMessage, raw: T): void {
    this.byMessage.set(message, raw);
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
    return first ? this.byToolCall.get(first.id) : undefined;
  }
}
