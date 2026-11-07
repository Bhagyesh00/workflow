/** Text completion models: one prompt in, text out. Stubs: L18 fills them. */
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
      throw new Error('not implemented (L18)');
    },
  };
}

export const textCompletionNodes: NodeType[] = [
  stub(
    'ai.lmCohere',
    'Cohere Model',
    'Text completion with Cohere models',
    'simple:cohere',
    ['cohere', 'text completion', 'llm'],
    'cohereApi',
  ),
  stub(
    'ai.lmOllama',
    'Ollama Model',
    'Text completion with models served by Ollama',
    'simple:ollama',
    ['llama', 'local', 'text completion', 'llm'],
    'ollamaApi',
  ),
  stub(
    'ai.lmLemonade',
    'Lemonade Model',
    'Text completion with models served by Lemonade',
    'lucide:citrus',
    ['lemonade', 'local', 'text completion', 'llm'],
    'lemonadeApi',
  ),
  stub(
    'ai.lmOpenHuggingFaceInference',
    'Hugging Face Inference Model',
    'Text completion through Hugging Face Inference',
    'simple:huggingface',
    ['hugging face', 'text completion', 'llm'],
    'huggingFaceApi',
  ),
];
