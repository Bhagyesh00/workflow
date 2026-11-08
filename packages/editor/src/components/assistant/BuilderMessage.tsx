/**
 * P5-62: one chat message of the builder. Text renders through `Markdown` (lib/markdown.tsx), never
 * as raw HTML. Stub until L2.
 */
import type { BuilderMessage as BuilderMessageData } from '@workflow/workflow';

export interface BuilderMessageProps {
  message: BuilderMessageData;
}

export function BuilderMessage(_props: BuilderMessageProps) {
  return null;
}
