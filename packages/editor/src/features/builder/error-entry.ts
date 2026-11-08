/**
 * P5-65: "Fix with AI" on a node's error: opens the builder and sends
 * `I'm getting an error on the node "<name>": <message>` (the server redacts it before the model sees it).
 */
import { useBuilderStore } from '../../stores/builder-store';

/** keeps the whole message inside the builder's prompt limit */
const MAX_ERROR_CHARS = 1000;

export function builderErrorMessage(nodeName: string, error: string): string {
  return `I'm getting an error on the node "${nodeName}": ${error.slice(0, MAX_ERROR_CHARS)}`;
}

export async function openBuilderForError(nodeName: string, error: string): Promise<void> {
  const store = useBuilderStore.getState();
  store.setOpen(true);
  await store.send(builderErrorMessage(nodeName, error));
}
