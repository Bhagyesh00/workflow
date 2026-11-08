/**
 * P5-67 (L2): one Assistant event applied to the open thread's state. Pure: deltas append to the live segment
 * and `text-block` replaces it with a message, so a reconnect mid-block never shows text twice; a durable event
 * with an id at or below `cursor` changes nothing.
 */
import type { AssistantEvent } from '@workflow/workflow';
import type { AssistantThreadState } from '../../stores/assistant-store';

export function reduceAssistantEvent(
  _state: AssistantThreadState,
  _event: AssistantEvent,
): AssistantThreadState {
  throw new Error('not implemented (L2)');
}
