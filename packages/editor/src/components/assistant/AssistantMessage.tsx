/**
 * P5-67 (L2): one message. Text through `Markdown` (lib/markdown.tsx), never raw HTML; an assistant message
 * shows the tool rows of its calls (name, running, done, failed, details collapsed).
 */
import type { AssistantMessageDTO } from '@workflow/workflow';
import type { AssistantToolRun } from '../../stores/assistant-store';

export interface AssistantMessageProps {
  message: AssistantMessageDTO;
  /** the rows of this message's tool calls */
  toolRuns?: AssistantToolRun[];
}

export function AssistantMessage(_props: AssistantMessageProps) {
  // L2 renders it
  return null;
}
