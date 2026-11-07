/**
 * Custom data keys for "Auto-save highlighted data": the Chat Trigger, the Chat node and the Agent write
 * these on the execution, and the Execution Data node and the executions filter read them.
 */

/** a run of capitals before a capitalised word, a word, a run of capitals, digits, caseless letters, emoji */
const WORD =
  /\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lu}+|\p{N}+|[^\P{L}\p{Lu}\p{Ll}]+|\p{Extended_Pictographic}/gu;

function snakeCase(text: string): string {
  const plain = text.normalize('NFD').replace(/\p{M}/gu, '').replace(/['’]/g, '');
  return (plain.match(WORD) ?? []).map((word) => word.toLowerCase()).join('_');
}

export function highlightedInputKey(nodeName: string): string {
  return `input_${snakeCase(nodeName)}`;
}

export function highlightedResponseKey(nodeName: string): string {
  return `response_${snakeCase(nodeName)}`;
}

export const HIGHLIGHTED_SESSION_KEY = 'session_id';
