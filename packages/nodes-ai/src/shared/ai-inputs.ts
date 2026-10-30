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

async function single<T>(
  ctx: AnyContext,
  type: ConnectionType,
  kind: string,
  itemIndex: number,
  label: string,
  required: boolean,
): Promise<T | undefined> {
  const raw = await ctx.getInputConnectionData(type, itemIndex);
  const value = Array.isArray(raw) ? raw[0] : raw;
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

export async function getChatModel(ctx: AnyContext, itemIndex: number): Promise<AiChatModel> {
  return (await single<AiChatModel>(ctx, 'ai_languageModel', 'chatModel', itemIndex, 'chat model', true))!;
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

export function getPrompt(ctx: ExecuteContext, itemIndex: number, item: Item): string {
  const promptType = ctx.getNodeParameter('promptType', itemIndex, 'auto') as string;
  if (promptType === 'auto') {
    const chatInput = item.json.chatInput;
    if (typeof chatInput !== 'string' || !chatInput.trim()) {
      throw new NodeOperationError(ctx.getNode(), 'No "chatInput" field in the input item', {
        itemIndex,
        description:
          'Connect a Chat Trigger, or set "Source for Prompt" to "Define Below" and map the prompt from the input.',
      });
    }
    return chatInput;
  }
  const text = ctx.getNodeParameter('text', itemIndex, '');
  const prompt = typeof text === 'string' ? text : JSON.stringify(text);
  if (!prompt.trim()) {
    throw new NodeOperationError(ctx.getNode(), 'The prompt is empty', { itemIndex, parameter: 'text' });
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
