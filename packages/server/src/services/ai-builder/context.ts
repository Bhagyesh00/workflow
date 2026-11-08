/**
 * What the builder tells the model about the workflow (P5-09). `buildWorkflowContext` and
 * `sanitizeForModel` are L1's: credentials removed, parameter values through `redactSecrets` and the
 * trim steps, "send data values" off gives structure only, last run of this workflow only.
 * `wrapUntrusted` is FULL from C0: every piece of node output, run data, page, plan note or existing
 * parameter goes through it before it reaches a model.
 */
import type { WorkflowDefinition } from '@workflow/workflow';
import type { ServerContext } from '../../context';
import type { TenantRow } from '../../db/schema';

export interface BuildWorkflowContextInput {
  ctx: ServerContext;
  tenant: TenantRow;
  /** the workflow row, which must be the tenant's */
  workflowId: string;
  /** the editor's current definition, already parsed by `workflowDataSchema` */
  definition: WorkflowDefinition;
  /** the tenant's "send data values" setting */
  sendValues: boolean;
}

export async function buildWorkflowContext(_input: BuildWorkflowContextInput): Promise<string> {
  throw new Error('not implemented (L1)');
}

/** the definition as the model may see it: no credentials, values redacted and trimmed */
export function sanitizeForModel(_definition: WorkflowDefinition): unknown {
  throw new Error('not implemented (L1)');
}

export const UNTRUSTED_TAG = 'untrusted_data';

/**
 * Wraps outside text as `<untrusted_data source="...">` data the model must never follow. Every `<` in
 * `text` becomes `&lt;` and `source` keeps only `[\w .:-]`, so neither a page nor a node name can close
 * the wrapper or open another tag.
 */
export function wrapUntrusted(source: string, text: string): string {
  const safeSource = String(source ?? '').replace(/[^\w .:-]/g, '');
  const safeText = String(text ?? '').replace(/</g, '&lt;');
  return `<${UNTRUSTED_TAG} source="${safeSource}">\n${safeText}\n</${UNTRUSTED_TAG}>`;
}
