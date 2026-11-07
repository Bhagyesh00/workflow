/**
 * Anthropic prompt tools (beta header `prompt-tools-2025-04-02`): generate a prompt from a task, improve a
 * prompt with feedback, templatize a prompt into variables. The endpoints are Anthropic's experimental ones.
 */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { messagesProperty, readVendorMessages } from '../shared/messages';
import { anthropicBaseUrl, anthropicCall, forOperation, PROMPT_TOOLS_BETA } from './message';

const optionsFor = (extra: NodeProperty[]): NodeProperty => ({
  displayName: 'Options',
  name: 'options',
  type: 'collection',
  default: {},
  placeholder: 'Add option',
  options: [
    ...extra,
    {
      displayName: 'Target Model',
      name: 'targetModel',
      type: 'string',
      default: '',
      description: 'The model the prompt is meant for, such as claude-sonnet-5-5',
    },
  ],
});

const systemOption: NodeProperty = {
  displayName: 'System Message',
  name: 'system',
  type: 'string',
  default: '',
  typeOptions: { rows: 2 },
};

export const promptProperties: NodeProperty[] = [
  ...forOperation('prompt', 'generate', [
    {
      displayName: 'Task',
      name: 'task',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { rows: 3 },
      description: 'What the prompt should make a model do',
    },
    optionsFor([]),
  ]),
  ...forOperation('prompt', 'improve', [
    messagesProperty({ roles: ['user', 'assistant'] }),
    {
      displayName: 'Feedback',
      name: 'feedback',
      type: 'string',
      default: '',
      typeOptions: { rows: 2 },
      description: 'What to change about the prompt',
    },
    optionsFor([systemOption]),
  ]),
  ...forOperation('prompt', 'templatize', [
    messagesProperty({ roles: ['user', 'assistant'] }),
    optionsFor([systemOption]),
  ]),
];

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

async function promptMessages(ctx: ExecuteContext, itemIndex: number): Promise<DataObject[]> {
  const messages = await readVendorMessages(ctx, itemIndex);
  if (messages.length === 0) {
    throw new NodeOperationError(ctx.getNode(), 'Add at least one message', { itemIndex });
  }
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

export async function executePrompt(
  ctx: ExecuteContext,
  itemIndex: number,
  operation: string,
): Promise<Item> {
  if (operation !== 'generate' && operation !== 'improve' && operation !== 'templatize') {
    throw new NodeOperationError(ctx.getNode(), `The operation "${operation}" is not known`, { itemIndex });
  }
  const baseUrl = await anthropicBaseUrl(ctx, itemIndex);
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const targetModel = text(options.targetModel);
  const system = text(options.system);
  let path: string;
  let body: DataObject;
  if (operation === 'generate') {
    const task = text(ctx.getNodeParameter('task', itemIndex, ''));
    if (!task) throw new NodeOperationError(ctx.getNode(), 'Enter the task', { itemIndex });
    path = 'generate_prompt';
    body = { task };
  } else if (operation === 'improve') {
    path = 'improve_prompt';
    body = { messages: await promptMessages(ctx, itemIndex) };
    const feedback = text(ctx.getNodeParameter('feedback', itemIndex, ''));
    if (feedback) body.feedback = feedback;
  } else {
    path = 'templatize_prompt';
    body = { messages: await promptMessages(ctx, itemIndex) };
  }
  if (system && operation !== 'generate') body.system = system;
  if (targetModel) body.target_model = targetModel;
  const response = await anthropicCall<DataObject>(
    ctx,
    itemIndex,
    { url: `${baseUrl}/v1/experimental/${path}`, method: 'POST', body },
    [PROMPT_TOOLS_BETA],
  );
  return { json: response };
}
