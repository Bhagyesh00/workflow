/**
 * Copy a node's webhook URL to the clipboard (P3-02: Alt+U production, Shift+Alt+U test; menu
 * entries "Copy production URL" / "Copy test URL"). URLs come from workflowsApi.webhookUrls, so they
 * are the saved workflow's URLs; they are never logged or put in a toast.
 */
import { errorMessage } from '../../api/client';
import { workflowsApi } from '../../api/endpoints';
import { toast } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';

export type WebhookUrlKind = 'production' | 'test';

/** Resolves true when the URL was copied; otherwise shows why in a toast and resolves false. */
export async function copyNodeWebhookUrl(nodeName: string, kind: WebhookUrlKind): Promise<boolean> {
  const id = useWorkflowStore.getState().meta.id;
  if (!id) {
    toast.error('Could not copy the URL', 'Save the workflow first.');
    return false;
  }
  try {
    const urls = await workflowsApi.webhookUrls(id);
    const hook = urls.find((u) => u.nodeName === nodeName);
    if (!hook) {
      toast.error('Could not copy the URL', `"${nodeName}" has no webhook URL.`);
      return false;
    }
    if (!navigator.clipboard) {
      toast.error('Could not copy the URL', 'The clipboard is not available in this browser.');
      return false;
    }
    await navigator.clipboard.writeText(kind === 'test' ? hook.testUrl : hook.productionUrl);
    toast.success(kind === 'test' ? 'Test URL copied' : 'Production URL copied', nodeName);
    return true;
  } catch (error) {
    toast.error('Could not copy the URL', errorMessage(error));
    return false;
  }
}
