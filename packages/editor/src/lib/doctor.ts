/**
 * Workflow Doctor: static checks that run in the browser while you edit, so problems show up
 * before a run fails or activation is refused. Each finding points at a node when it can.
 *
 * The code lives in `@workflow/workflow` (workflow-lint.ts) since Phase 5 S4, so the server's
 * builder lints with the same rules; this file keeps the editor's import paths.
 */
export {
  collectExpressions,
  type DescriptionLookup,
  type DoctorInput,
  type DoctorIssue,
  type IssueSeverity,
  issuesByNode,
  lintWorkflow,
  nodeCredentialSlots,
  referencedNodes,
  selectedCredentialSlots,
} from '@workflow/workflow';
