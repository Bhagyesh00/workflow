/**
 * "Chat" tab of the log panel (P5-59): the chat widget (`createChat` of @workflow/chat-widget)
 * mounted in a ref, talking to the workflow's chat trigger through its test URL and `chatFetch`.
 * C0 stub: L5 fills it (chat-store.ts, chat-actions.ts, EmbedModal). It renders, never throws, and
 * makes no request on mount.
 */
import { EmptyState } from '../ui/misc';

export function ChatPanel() {
  return (
    <EmptyState
      title="Chat with this workflow"
      description="Send a message to the chat trigger to run the workflow."
      className="py-8"
    />
  );
}
