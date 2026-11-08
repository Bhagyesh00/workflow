/**
 * P5-66: keeps the builder's saved chat in step with the workflow's versions. Each does nothing until
 * L6 fills it: the version restore (WorkflowEditorPage) and L2's Accept already call them.
 */

/** a version restore: the chat goes back to the message whose `versionId` is the restored one */
export async function onVersionRestored(_workflowId: string, _versionId: string): Promise<void> {
  // L6
}

/** Accept saved `versionId`: `aiApi.acceptedVersion` */
export async function onDraftAccepted(_workflowId: string, _versionId: string): Promise<void> {
  // L6
}

/** the panel's "Clear chat": `aiApi.clear`, then the store's messages */
export async function clearBuilderSession(_workflowId: string): Promise<void> {
  // L6
}
