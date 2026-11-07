/** AWS Bedrock Chat Model sub-node. Stub: L11 fills it. */
import type { NodeType } from '@workflow/workflow';
import { modelDescription } from './model-options';

export const LmChatAwsBedrockNode: NodeType = {
  description: {
    ...modelDescription(
      {
        name: 'ai.lmChatAwsBedrock',
        displayName: 'AWS Bedrock Chat Model',
        description: 'Chat models on AWS Bedrock through the Converse API',
        icon: 'simple:amazonaws',
        alias: ['bedrock', 'aws', 'titan', 'llm'],
        credential: 'aws',
        defaultsName: 'AWS Bedrock Chat Model',
      },
      [],
    ),
    credentials: [
      { name: 'aws', required: true, displayOptions: { show: { authentication: ['iam'] } } },
      { name: 'awsAssumeRole', required: true, displayOptions: { show: { authentication: ['assumeRole'] } } },
    ],
  },
  async supplyData() {
    throw new Error('not implemented (L11)');
  },
};
