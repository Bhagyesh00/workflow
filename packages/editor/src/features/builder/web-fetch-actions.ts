/**
 * P5-64: the user's decision on a page the builder asked to read. It goes to the server as
 * `resumeData.webFetch` on a new turn with no text; the server adds the host to the session on approve,
 * reads the page and carries on (or notes the refusal and carries on without it). The store clears the
 * pending request when the turn starts, and does nothing while a turn streams or on a read-only canvas.
 */
import { useBuilderStore } from '../../stores/builder-store';

export async function decideWebFetch(url: string, decision: 'approve' | 'deny'): Promise<void> {
  await useBuilderStore.getState().send('', { resumeData: { webFetch: { url, decision } } });
}
