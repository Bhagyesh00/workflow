/**
 * Port derivation for canvas nodes: static lists, expression-driven (dynamic) ports, AI ports on
 * root nodes, sub-node outputs and the extra error output of `onError: continueErrorOutput`.
 * Also the connection rules used while dragging cables.
 *
 * The code lives in `@workflow/workflow` (workflow-lint.ts) since Phase 5 S4, so the server's
 * builder lints with the same rules; this file keeps the editor's import paths.
 */
export {
  AI_PORT_LABELS,
  type ConnectionAttempt,
  canConnect,
  connectionExists,
  countInputConnections,
  deriveNodePorts,
  evaluatePortList,
  handleId,
  isTriggerDescription,
  latestVersion,
  type NodePorts,
  type PortDirection,
  type PortSpec,
  parseHandleId,
} from '@workflow/workflow';
