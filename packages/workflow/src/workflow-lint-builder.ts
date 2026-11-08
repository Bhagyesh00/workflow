/**
 * Lint for the AI builder and the MCP builder tools: `lintWorkflow` plus the builder's own checks,
 * each with a `code` (L1 adds them). `lintWorkflow` itself stays unchanged. Isomorphic: no Node API.
 */
import { type DescriptionLookup, type DoctorInput, type DoctorIssue, lintWorkflow } from './workflow-lint';

/** C0: the same issues as `lintWorkflow`; L1 adds the builder checks */
export function lintForBuilder(input: DoctorInput, types: DescriptionLookup): DoctorIssue[] {
  return lintWorkflow(input, types);
}
