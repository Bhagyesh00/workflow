/**
 * Typed access to the sub-nodes connected to a root node (model, memory, tools, parser...),
 * plus the prompt parameters shared by the agent and the chains.
 */
import {
  type AiChatModel,
  type AiDocument,
  type AiDocumentLoader,
  type AiEmbeddings,
  type AiImagePart,
  type AiMemory,
  type AiOutputParser,
  type AiReranker,
  type AiRetriever,
  type AiTextSplitter,
  type AiTool,
  type AiVectorStore,
  type ConnectionType,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
  type SupplyDataContext,
} from '@workflow/workflow';

type AnyContext = ExecuteContext | SupplyDataContext;

/** Memory as supplied by this package's memory nodes: bound to the session key of the item. */
export interface SessionMemory extends AiMemory {
  readonly sessionId?: string;
}

function isKind<T>(value: unknown, kind: string): value is T {
  return Boolean(value) && typeof value === 'object' && (value as { kind?: string }).kind === kind;
}

/**
 * The value of one port. A parent with several ports of a type gets an array by slot, `undefined` for an
 * empty slot; a parent with one port gets the value or a list, so only slot 0 can answer.
 */
function atSlot(raw: unknown, slot: number): unknown {
  if (!Array.isArray(raw)) return slot === 0 ? raw : undefined;
  const entry = raw[slot];
  return Array.isArray(entry) ? entry[0] : entry;
}

async function single<T>(
  ctx: AnyContext,
  type: ConnectionType,
  kind: string,
  itemIndex: number,
  label: string,
  required: boolean,
  slot = 0,
): Promise<T | undefined> {
  const raw = await ctx.getInputConnectionData(type, itemIndex);
  const value = atSlot(raw, slot);
  if (value === undefined || value === null) {
    if (required)
      throw new NodeOperationError(ctx.getNode(), `Connect a ${label} to this node`, { itemIndex });
    return undefined;
  }
  if (!isKind<T>(value, kind)) {
    throw new NodeOperationError(ctx.getNode(), `The node connected as ${label} does not supply a ${kind}`, {
      itemIndex,
    });
  }
  return value;
}

/** Model nodes that take a prompt and have no chat or tool calls; `filter.excludedNodes` of chat-only ports. */
export const COMPLETION_MODEL_NODES: string[] = [
  'ai.lmCohere',
  'ai.lmOllama',
  'ai.lmLemonade',
  'ai.lmOpenHuggingFaceInference',
];

export async function getChatModel(
  ctx: AnyContext,
  itemIndex: number,
  options?: { chatOnly?: boolean; slot?: number },
): Promise<AiChatModel> {
  const model = (await single<AiChatModel>(
    ctx,
    'ai_languageModel',
    'chatModel',
    itemIndex,
    'chat model',
    true,
    options?.slot,
  ))!;
  if (options?.chatOnly && model.completion) {
    throw new NodeOperationError(
      ctx.getNode(),
      `${model.nodeName ?? 'The connected model'} is a text completion model; connect a chat model`,
      { itemIndex },
    );
  }
  return model;
}

/** The model on the second port, for nodes with the fallback option on. */
export async function getFallbackModel(ctx: AnyContext, itemIndex: number): Promise<AiChatModel> {
  const model = await single<AiChatModel>(
    ctx,
    'ai_languageModel',
    'chatModel',
    itemIndex,
    'fallback model',
    false,
    1,
  );
  if (!model) {
    throw new NodeOperationError(
      ctx.getNode(),
      'Please connect a model to the Fallback Model input or disable the fallback option',
      { itemIndex },
    );
  }
  return model;
}

export function getMemory(ctx: AnyContext, itemIndex: number): Promise<SessionMemory | undefined> {
  return single<SessionMemory>(ctx, 'ai_memory', 'memory', itemIndex, 'memory', false);
}

export function getOutputParser(ctx: AnyContext, itemIndex: number, required = false) {
  return single<AiOutputParser>(ctx, 'ai_outputParser', 'outputParser', itemIndex, 'output parser', required);
}

export function getEmbeddings(ctx: AnyContext, itemIndex: number): Promise<AiEmbeddings | undefined> {
  return single<AiEmbeddings>(ctx, 'ai_embedding', 'embeddings', itemIndex, 'embeddings model', true);
}

export function getVectorStore(ctx: AnyContext, itemIndex: number, required = true) {
  return single<AiVectorStore>(ctx, 'ai_vectorStore', 'vectorStore', itemIndex, 'vector store', required);
}

export function getRetriever(ctx: AnyContext, itemIndex: number) {
  return single<AiRetriever>(ctx, 'ai_retriever', 'retriever', itemIndex, 'retriever', false);
}

/** The reranker on the `ai_reranker` port, or `undefined` when none is connected. */
export function getReranker(ctx: AnyContext, itemIndex: number): Promise<AiReranker | undefined> {
  return single<AiReranker>(ctx, 'ai_reranker', 'reranker', itemIndex, 'reranker', false);
}

export function getTextSplitter(ctx: AnyContext, itemIndex: number, required = false) {
  return single<AiTextSplitter>(ctx, 'ai_textSplitter', 'textSplitter', itemIndex, 'text splitter', required);
}

export function getDocumentLoader(ctx: AnyContext, itemIndex: number) {
  return single<AiDocumentLoader>(ctx, 'ai_document', 'documentLoader', itemIndex, 'document loader', true);
}

/** Tools from every connected tool node; a node may supply one tool or a list (MCP client). */
export async function getTools(ctx: AnyContext, itemIndex: number): Promise<AiTool[]> {
  const raw = await ctx.getInputConnectionData('ai_tool', itemIndex);
  const list = (Array.isArray(raw) ? raw : [raw]).flat(2).filter((t) => t !== undefined && t !== null);
  const tools: AiTool[] = [];
  const names = new Set<string>();
  for (const tool of list) {
    if (!isKind<AiTool>(tool, 'tool')) {
      throw new NodeOperationError(ctx.getNode(), 'A node connected as a tool does not supply a tool', {
        itemIndex,
      });
    }
    if (names.has(tool.name)) {
      throw new NodeOperationError(ctx.getNode(), `Two connected tools are both named "${tool.name}"`, {
        itemIndex,
        description: 'Tool names come from the node names; rename one of the tool nodes.',
      });
    }
    names.add(tool.name);
    tools.push(tool);
  }
  return tools;
}

// ---------------------------------------------------------------------------------------------
// Prompt parameters
// ---------------------------------------------------------------------------------------------

export const promptTypeProperty: NodeProperty = {
  displayName: 'Source for Prompt (User Message)',
  name: 'promptType',
  type: 'options',
  default: 'auto',
  noDataExpression: true,
  options: [
    {
      name: 'Connected Chat Trigger Node',
      value: 'auto',
      description: 'Uses the "chatInput" field sent by the Chat Trigger',
    },
    { name: 'Define Below', value: 'define', description: 'Write the prompt, or map it with an expression' },
  ],
};

export const promptTextProperty: NodeProperty = {
  displayName: 'Prompt (User Message)',
  name: 'text',
  type: 'string',
  default: '',
  required: true,
  placeholder: 'e.g. Hello, how can you help me?',
  typeOptions: { rows: 2 },
  displayOptions: { show: { promptType: ['define'] } },
};

/** `options.emptyText` replaces the text of both empty cases; without it the chains keep today's texts. */
export function getPrompt(
  ctx: ExecuteContext,
  itemIndex: number,
  item: Item,
  options?: { emptyText?: string },
): string {
  const promptType = ctx.getNodeParameter('promptType', itemIndex, 'auto') as string;
  if (promptType === 'auto') {
    const chatInput = item.json.chatInput;
    if (typeof chatInput !== 'string' || !chatInput.trim()) {
      throw new NodeOperationError(
        ctx.getNode(),
        options?.emptyText ?? 'No "chatInput" field in the input item',
        {
          itemIndex,
          description:
            'Connect a Chat Trigger, or set "Source for Prompt" to "Define Below" and map the prompt from the input.',
        },
      );
    }
    return chatInput;
  }
  const text = ctx.getNodeParameter('text', itemIndex, '');
  const prompt =
    typeof text === 'string' ? text : text === undefined || text === null ? '' : JSON.stringify(text);
  if (!prompt.trim()) {
    throw new NodeOperationError(ctx.getNode(), options?.emptyText ?? 'The prompt is empty', {
      itemIndex,
      parameter: 'text',
    });
  }
  return prompt;
}

/** Images attached to the input item, for vision-capable models. */
export async function binaryImages(
  ctx: ExecuteContext,
  itemIndex: number,
  item: Item,
): Promise<AiImagePart[]> {
  const images: AiImagePart[] = [];
  for (const [key, binary] of Object.entries(item.binary ?? {})) {
    if (!binary.mimeType?.startsWith('image/')) continue;
    const data = await ctx.helpers.getBinaryDataBuffer(itemIndex, key);
    images.push({ type: 'image', mimeType: binary.mimeType, data: Buffer.from(data).toString('base64') });
  }
  return images;
}

export function documentsToContext(documents: AiDocument[]): string {
  return documents.map((d) => d.pageContent).join('\n\n');
}
