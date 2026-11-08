/**
 * P5-67 (L2): the caller's threads, newest first: open one, new, rename, delete (with a confirm).
 */
import type { AssistantThreadDTO } from '@workflow/workflow';

export interface AssistantThreadListProps {
  threads: AssistantThreadDTO[];
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  onCreate: () => void;
  onRename: (threadId: string, title: string) => void;
  onDelete: (threadId: string) => void;
}

export function AssistantThreadList(_props: AssistantThreadListProps) {
  // L2 renders it
  return null;
}
