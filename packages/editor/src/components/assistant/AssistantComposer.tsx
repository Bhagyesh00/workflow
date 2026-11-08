/**
 * P5-67 (L2): the message box. Enter sends, Stop while a turn runs, disabled with the reason while a card waits;
 * mounts `AttachmentPicker` (L11) and sends its files through `readAttachments`.
 */
import type { AssistantSendMessage } from '@workflow/workflow';

export interface AssistantComposerProps {
  running: boolean;
  /** set while the composer cannot send, shown as the reason */
  disabledReason?: string | null;
  onSend: (body: AssistantSendMessage) => void | Promise<void>;
  onStop: () => void;
}

export function AssistantComposer(_props: AssistantComposerProps) {
  // L2 renders it
  return null;
}
