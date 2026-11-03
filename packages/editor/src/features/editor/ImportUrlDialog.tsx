/**
 * "Import from URL" (P3-13, as n8n ImportWorkflowUrlModal): open while ui.importUrlOpen; the URL
 * must match /^https?:\/\/.+/i; workflowsApi.importFromUrl sends it in the body (the server
 * fetches it); the result is pasted into the open workflow as one undo step. A result that arrives
 * after the user left the workflow is dropped.
 *
 * C0 STUB: lane L11 writes it; renders nothing until then.
 */
export function ImportUrlDialog(): null {
  return null;
}
