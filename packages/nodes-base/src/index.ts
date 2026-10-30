import type { CredentialType, NodePackage, NodeType } from '@workflow/workflow';
import {
  airtableTokenApi,
  mySql,
  notionApi,
  postgres,
  slackApi,
  smtp,
  telegramApi,
} from './credentials/apps.credentials';
import {
  httpBasicAuth,
  httpBearerAuth,
  httpCustomAuth,
  httpHeaderAuth,
  httpQueryAuth,
} from './credentials/http.credentials';
import {
  gmailOAuth2,
  googleOAuth2Api,
  googleSheetsOAuth2Api,
  oAuth2Api,
  slackOAuth2Api,
} from './credentials/oauth2.credentials';
import { CryptoNode } from './nodes/core/Crypto.node';
import { FilterNode, IfNode, SwitchNode } from './nodes/core/conditions.nodes';
import { DateTimeNode } from './nodes/core/DateTime.node';
import {
  AggregateNode,
  CompareDatasetsNode,
  LimitNode,
  RemoveDuplicatesNode,
  RenameKeysNode,
  SortNode,
  SplitOutNode,
  SummarizeNode,
} from './nodes/core/data.nodes';
import { ConvertToFileNode, ExtractFromFileNode } from './nodes/core/files.nodes';
import {
  ErrorTriggerNode,
  ExecuteWorkflowNode,
  ExecuteWorkflowTriggerNode,
  SplitInBatchesNode,
  StopAndErrorNode,
  WaitNode,
} from './nodes/core/flow.nodes';
import { HttpRequestNode } from './nodes/core/HttpRequest.node';
import { MergeNode } from './nodes/core/Merge.node';
import { HtmlNode, MarkdownNode, XmlNode } from './nodes/core/markup.nodes';
import { ScheduleTriggerNode } from './nodes/core/ScheduleTrigger.node';
import { SendEmailNode } from './nodes/core/SendEmail.node';
import {
  CodeNode,
  ManualTriggerNode,
  NoOpNode,
  RespondToWebhookNode,
  SetNode,
} from './nodes/core/simple.nodes';
import { WebhookNode } from './nodes/core/Webhook.node';
import { GraphqlNode, RssFeedReadNode } from './nodes/core/web.nodes';

export const coreNodes: NodeType[] = [
  ManualTriggerNode,
  WebhookNode,
  ScheduleTriggerNode,
  CodeNode,
  SetNode,
  NoOpNode,
  RespondToWebhookNode,
  HttpRequestNode,
  IfNode,
  FilterNode,
  SwitchNode,
  MergeNode,
  SplitInBatchesNode,
  WaitNode,
  ExecuteWorkflowNode,
  ExecuteWorkflowTriggerNode,
  ErrorTriggerNode,
  StopAndErrorNode,
  AggregateNode,
  SplitOutNode,
  SortNode,
  LimitNode,
  RemoveDuplicatesNode,
  SummarizeNode,
  RenameKeysNode,
  CompareDatasetsNode,
  DateTimeNode,
  CryptoNode,
  HtmlNode,
  XmlNode,
  MarkdownNode,
  ConvertToFileNode,
  ExtractFromFileNode,
  SendEmailNode,
  RssFeedReadNode,
  GraphqlNode,
];

export const appNodes: NodeType[] = [];

export const nodes: NodeType[] = [...coreNodes, ...appNodes];

export const credentials: CredentialType[] = [
  httpBasicAuth,
  httpHeaderAuth,
  httpQueryAuth,
  httpBearerAuth,
  httpCustomAuth,
  oAuth2Api,
  googleOAuth2Api,
  gmailOAuth2,
  googleSheetsOAuth2Api,
  slackApi,
  slackOAuth2Api,
  postgres,
  mySql,
  notionApi,
  airtableTokenApi,
  telegramApi,
  smtp,
];

export const nodesBasePackage: NodePackage = { name: '@workflow/nodes-base', nodes, credentials };

export { ruleToCron } from './nodes/core/ScheduleTrigger.node';
export {
  coerce as coerceFilterValue,
  evaluateCondition,
  evaluateFilter,
  FilterError,
  OPERATIONS_BY_TYPE,
  SINGLE_VALUE_OPERATIONS,
} from './utils/filter';
