/** Named OpenAI-compatible chat models. Stubs: L19 fills them. */
import type { NodeType } from '@workflow/workflow';
import { modelDescription } from './model-options';

function stub(
  name: string,
  displayName: string,
  description: string,
  icon: string,
  alias: string[],
  credential: string,
): NodeType {
  return {
    description: modelDescription(
      { name, displayName, description, icon, alias, credential, defaultsName: displayName },
      [],
    ),
    async supplyData() {
      throw new Error('not implemented (L19)');
    },
  };
}

export const openAiPresetNodes: NodeType[] = [
  stub(
    'ai.lmChatDeepSeek',
    'DeepSeek Chat Model',
    'Chat with DeepSeek models',
    'simple:deepseek',
    ['deepseek', 'llm'],
    'deepSeekApi',
  ),
  stub(
    'ai.lmChatXAiGrok',
    'xAI Grok Chat Model',
    'Chat with xAI Grok models',
    'simple:x',
    ['xai', 'grok', 'llm'],
    'xAiApi',
  ),
  stub(
    'ai.lmChatOpenRouter',
    'OpenRouter Chat Model',
    'Chat with any model on OpenRouter',
    'simple:openrouter',
    ['openrouter', 'router', 'llm'],
    'openRouterApi',
  ),
  stub(
    'ai.lmChatVercelAiGateway',
    'Vercel AI Gateway Chat Model',
    'Chat through the Vercel AI Gateway',
    'simple:vercel',
    ['vercel', 'gateway', 'llm'],
    'vercelAiGatewayApi',
  ),
  stub(
    'ai.lmChatNvidia',
    'NVIDIA Chat Model',
    'Chat with models hosted by NVIDIA',
    'simple:nvidia',
    ['nvidia', 'nemotron', 'nim', 'llm'],
    'nvidiaApi',
  ),
  stub(
    'ai.lmChatMoonshot',
    'Moonshot Kimi Chat Model',
    'Chat with Moonshot Kimi models',
    'simple:moonshot',
    ['moonshot', 'kimi', 'llm'],
    'moonshotApi',
  ),
  stub(
    'ai.lmChatMinimax',
    'MiniMax Chat Model',
    'Chat with MiniMax models',
    'simple:minimax',
    ['minimax', 'llm'],
    'minimaxApi',
  ),
  stub(
    'ai.lmChatAlibabaCloud',
    'Qwen Chat Model',
    'Chat with Qwen models on Alibaba Cloud',
    'simple:alibabacloud',
    ['qwen', 'alibaba', 'dashscope', 'llm'],
    'alibabaCloudApi',
  ),
  stub(
    'ai.lmChatDatabricks',
    'Databricks Chat Model',
    'Chat with models on a Databricks AI Gateway',
    'simple:databricks',
    ['databricks', 'llm'],
    'databricksOAuth2Api',
  ),
  stub(
    'ai.lmChatLemonade',
    'Lemonade Chat Model',
    'Chat with models served by Lemonade',
    'lucide:citrus',
    ['lemonade', 'local', 'llm'],
    'lemonadeApi',
  ),
  stub(
    'ai.lmChatGroq',
    'Groq Chat Model',
    'Chat with models hosted by Groq',
    'simple:groq',
    ['groq', 'llm'],
    'groqApi',
  ),
];
