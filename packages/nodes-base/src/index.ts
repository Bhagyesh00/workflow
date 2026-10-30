import type { CredentialType, NodePackage, NodeType } from '@workflow/workflow';
import { httpBasicAuth, httpHeaderAuth } from './credentials/http.credentials';
import { ScheduleTriggerNode } from './nodes/core/ScheduleTrigger.node';
import {
  CodeNode,
  ManualTriggerNode,
  NoOpNode,
  RespondToWebhookNode,
  SetNode,
} from './nodes/core/simple.nodes';
import { WebhookNode } from './nodes/core/Webhook.node';

export const nodes: NodeType[] = [
  ManualTriggerNode,
  WebhookNode,
  ScheduleTriggerNode,
  CodeNode,
  SetNode,
  NoOpNode,
  RespondToWebhookNode,
];

export const credentials: CredentialType[] = [httpBasicAuth, httpHeaderAuth];

export const nodesBasePackage: NodePackage = { name: '@workflow/nodes-base', nodes, credentials };

export { ruleToCron } from './nodes/core/ScheduleTrigger.node';
