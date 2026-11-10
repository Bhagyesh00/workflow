import type { CredentialType, NodePackage, NodeType } from '@workflow/workflow';
import { amqp } from './credentials/amqp.credentials';
import {
  airtableTokenApi,
  mySql,
  notionApi,
  postgres,
  redis,
  slackApi,
  smtp,
  telegramApi,
} from './credentials/apps.credentials';
import { aws, awsAssumeRole } from './credentials/aws.credentials';
import { databricksOAuth2Api } from './credentials/databricks.credentials';
import { httpDigestAuth } from './credentials/digest.credentials';
import { ftp, sftp } from './credentials/ftp.credentials';
import { googleApi } from './credentials/google.credentials';
import {
  httpBasicAuth,
  httpBearerAuth,
  httpCustomAuth,
  httpHeaderAuth,
  httpMultipleHeadersAuth,
  httpQueryAuth,
  webhookSigningSecret,
} from './credentials/http.credentials';
import { imap } from './credentials/imap.credentials';
import { jwtAuth } from './credentials/jwt.credentials';
import { kafka, schemaRegistryApi } from './credentials/kafka.credentials';
import { mongoDb } from './credentials/mongodb.credentials';
import { mqtt } from './credentials/mqtt.credentials';
import { oAuth1Api } from './credentials/oauth1.credentials';
import {
  gmailOAuth2,
  googleOAuth2Api,
  googleSheetsOAuth2Api,
  oAuth2Api,
  slackOAuth2Api,
} from './credentials/oauth2.credentials';
import { rabbitmq } from './credentials/rabbitmq.credentials';
import { sshPassword, sshPrivateKey } from './credentials/ssh.credentials';
import { supabaseApi } from './credentials/supabase.credentials';
import { totpApi } from './credentials/totp.credentials';
import { AirtableNode } from './nodes/apps/Airtable.node';
import { AmqpNode } from './nodes/apps/amqp/Amqp.node';
import { AmqpTriggerNode } from './nodes/apps/amqp/AmqpTrigger.node';
import { GmailNode, GmailTriggerNode } from './nodes/apps/google/Gmail.node';
import { GoogleSheetsNode } from './nodes/apps/google/GoogleSheets.node';
import { KafkaNode } from './nodes/apps/kafka/Kafka.node';
import { KafkaTriggerNode } from './nodes/apps/kafka/KafkaTrigger.node';
import { MqttNode } from './nodes/apps/mqtt/Mqtt.node';
import { MqttTriggerNode } from './nodes/apps/mqtt/MqttTrigger.node';
import { NotionNode } from './nodes/apps/Notion.node';
import { RabbitMqNode } from './nodes/apps/rabbitmq/RabbitMq.node';
import { RabbitMqTriggerNode } from './nodes/apps/rabbitmq/RabbitMqTrigger.node';
import { RedisNode } from './nodes/apps/redis/Redis.node';
import { RedisTriggerNode } from './nodes/apps/redis/RedisTrigger.node';
import { SlackNode } from './nodes/apps/Slack.node';
import { MySqlNode } from './nodes/apps/sql/MySql.node';
import { PostgresNode } from './nodes/apps/sql/Postgres.node';
import { PostgresTriggerNode } from './nodes/apps/sql/PostgresTrigger.node';
import { TelegramNode, TelegramTriggerNode } from './nodes/apps/Telegram.node';
import { CompressionNode } from './nodes/core/Compression.node';
import { CryptoNode } from './nodes/core/Crypto.node';
import { FilterNode, IfNode, SwitchNode } from './nodes/core/conditions.nodes';
import { DataTableNode } from './nodes/core/DataTable.node';
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
import { EditImageNode } from './nodes/core/EditImage.node';
import { EmailReadImapNode } from './nodes/core/EmailReadImap.node';
import { EvaluationNode } from './nodes/core/Evaluation.node';
import { EvaluationTriggerNode } from './nodes/core/EvaluationTrigger.node';
import { ExecutionDataNode } from './nodes/core/ExecutionData.node';
import { FormNode } from './nodes/core/Form.node';
import { FormTriggerNode } from './nodes/core/FormTrigger.node';
import { FtpNode } from './nodes/core/Ftp.node';
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
import { JwtNode } from './nodes/core/Jwt.node';
import { MergeNode } from './nodes/core/Merge.node';
import { HtmlNode, MarkdownNode, XmlNode } from './nodes/core/markup.nodes';
import { RssFeedReadTriggerNode } from './nodes/core/RssFeedReadTrigger.node';
import { ScheduleTriggerNode } from './nodes/core/ScheduleTrigger.node';
import { SendEmailNode } from './nodes/core/SendEmail.node';
import { SseTriggerNode } from './nodes/core/SseTrigger.node';
import { SshNode } from './nodes/core/Ssh.node';
import {
  CodeNode,
  ManualTriggerNode,
  NoOpNode,
  RespondToWebhookNode,
  SetNode,
} from './nodes/core/simple.nodes';
import { TimeSavedNode } from './nodes/core/TimeSaved.node';
import { TotpNode } from './nodes/core/Totp.node';
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
  JwtNode,
  TotpNode,
  CompressionNode,
  EditImageNode,
  FtpNode,
  SshNode,
  FormTriggerNode,
  FormNode,
  DataTableNode,
  SseTriggerNode,
  RssFeedReadTriggerNode,
  EmailReadImapNode,
  EvaluationTriggerNode,
  EvaluationNode,
  ExecutionDataNode,
  TimeSavedNode,
];

export const appNodes: NodeType[] = [
  SlackNode,
  GmailNode,
  GmailTriggerNode,
  GoogleSheetsNode,
  PostgresNode,
  MySqlNode,
  NotionNode,
  AirtableNode,
  TelegramNode,
  TelegramTriggerNode,
  PostgresTriggerNode,
  RedisTriggerNode,
  RedisNode,
  KafkaTriggerNode,
  KafkaNode,
  RabbitMqTriggerNode,
  RabbitMqNode,
  MqttTriggerNode,
  MqttNode,
  AmqpTriggerNode,
  AmqpNode,
];

export const nodes: NodeType[] = [...coreNodes, ...appNodes];

export const credentials: CredentialType[] = [
  httpBasicAuth,
  httpHeaderAuth,
  httpMultipleHeadersAuth,
  httpQueryAuth,
  httpBearerAuth,
  httpCustomAuth,
  webhookSigningSecret,
  oAuth2Api,
  googleOAuth2Api,
  gmailOAuth2,
  googleSheetsOAuth2Api,
  slackApi,
  slackOAuth2Api,
  postgres,
  redis,
  mySql,
  notionApi,
  airtableTokenApi,
  telegramApi,
  smtp,
  jwtAuth,
  totpApi,
  ftp,
  sftp,
  sshPassword,
  sshPrivateKey,
  oAuth1Api,
  httpDigestAuth,
  imap,
  kafka,
  schemaRegistryApi,
  rabbitmq,
  mqtt,
  amqp,
  aws,
  awsAssumeRole,
  googleApi,
  databricksOAuth2Api,
  mongoDb,
  supabaseApi,
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
export { parseOAuthResponse, signOAuth1Request } from './utils/oauth1';
export { createSmtpTransport } from './utils/smtp-transport';
export { base32Decode, totp } from './utils/totp';
export { verifyWebhookSignature } from './utils/webhook-signature';
