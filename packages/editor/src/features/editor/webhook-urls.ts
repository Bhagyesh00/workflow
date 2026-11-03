/**
 * Copy a node's webhook URL to the clipboard (P3-02: Alt+U production, Shift+Alt+U test; menu
 * entries "Copy production URL" / "Copy test URL"). URLs come from workflowsApi.webhookUrls.
 *
 * C0 STUB: lane L2 writes the body (resolves true when copied).
 */
export type WebhookUrlKind = 'production' | 'test';

export function copyNodeWebhookUrl(_nodeName: string, _kind: WebhookUrlKind): Promise<boolean> {
  throw new Error('not implemented (L2)');
}
