import type { ChatStrings } from './index';

/** Our own default texts (English). No branding line: `footer` is empty. */
export const DEFAULT_STRINGS: ChatStrings = {
  title: 'Chat',
  subtitle: 'Ask a question to start the conversation.',
  footer: '',
  getStarted: 'New conversation',
  inputPlaceholder: 'Type your question...',
  closeButtonTooltip: 'Close chat',
  repostButton: 'Send again',
  reuseButton: 'Use as new message',
};

export const ERROR_MESSAGES = {
  htmlReply: 'The server answered with a web page instead of a chat reply.',
  failed: "Couldn't send the message.",
};

/** Merge `i18n.en` over our defaults; only string values replace a default. */
export function mergeStrings(override?: Partial<ChatStrings>): ChatStrings {
  const merged: ChatStrings = { ...DEFAULT_STRINGS };
  if (!override) return merged;
  for (const key of Object.keys(DEFAULT_STRINGS) as (keyof ChatStrings)[]) {
    const value = override[key];
    if (typeof value === 'string') merged[key] = value;
  }
  return merged;
}
