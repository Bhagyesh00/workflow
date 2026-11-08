/**
 * P5-66: keeps the builder's saved chat in step with the workflow's versions. A version restore
 * (WorkflowEditorPage), L2's Accept and the panel's "Clear chat" call these; the server holds the chat
 * (`aiApi`), the store shows it.
 */
import { isApiError } from '../../api/client';
import { aiApi } from '../../api/endpoints';
import { useBuilderStore } from '../../stores/builder-store';
import { toast } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';

/** the store shows this workflow's chat only while this workflow is open */
const isOpen = (workflowId: string): boolean => useWorkflowStore.getState().meta.id === workflowId;

/**
 * A version restore: the chat goes back to the message whose `versionId` is the restored one. Later
 * messages are removed (the server records where the chat resumes); a version no message names leaves
 * the chat as it is.
 */
export async function onVersionRestored(workflowId: string, versionId: string): Promise<void> {
  try {
    const session = await aiApi.sessions(workflowId);
    const messages = session.messages ?? [];
    const at = messages.findIndex((message) => message.versionId === versionId);
    if (at < 0) return;
    const next = messages[at + 1];
    if (next) await aiApi.truncate(workflowId, next.id);
    if (isOpen(workflowId)) {
      const store = useBuilderStore.getState();
      store.setMessages(messages.slice(0, at + 1));
      store.setQuestions(null);
      store.setPlan(null);
    }
  } catch (error) {
    // every /ai/* route answers 404 while the builder is off (AI_ENABLED, the default): no chat to update
    if (isApiError(error, 404)) return;
    toast.error("Couldn't update the chat for the restored version");
  }
}

/** Accept saved `versionId`: `aiApi.acceptedVersion` tags the last message with it */
export async function onDraftAccepted(workflowId: string, versionId: string): Promise<void> {
  await aiApi.acceptedVersion(workflowId, versionId);
  if (!isOpen(workflowId)) return;
  const store = useBuilderStore.getState();
  const messages = store.messages;
  const last = messages.at(-1);
  if (last && last.versionId !== versionId) {
    store.setMessages([...messages.slice(0, -1), { ...last, versionId }]);
  }
}

/** the panel's "Clear chat": `aiApi.clear`, then the store's messages */
export async function clearBuilderSession(workflowId: string): Promise<void> {
  try {
    await aiApi.clear(workflowId);
  } catch {
    toast.error("Couldn't clear the chat");
    return;
  }
  if (!isOpen(workflowId)) return;
  const store = useBuilderStore.getState();
  store.setMessages([]);
  store.setQuestions(null);
  store.setPlan(null);
  store.setError(null);
}
