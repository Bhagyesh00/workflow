import type {
  AiTextSplitter,
  NodeProperty,
  NodeType,
  NodeTypeDescription,
  SupplyDataContext,
} from '@workflow/workflow';
import { NodeOperationError } from '@workflow/workflow';
import { CODE_LANGUAGES, type CodeLanguage, isCodeLanguage } from '../../shared/code-separators';
import {
  type SplitOptions,
  splitByCharacter,
  splitCode,
  splitRecursively,
} from '../../shared/text-splitting';
import { splitByTokens } from '../../shared/token-splitting';
import { errorMessage } from '../../shared/utils';

const sizeProperties: NodeProperty[] = [
  {
    displayName: 'Chunk Size',
    name: 'chunkSize',
    type: 'number',
    default: 1000,
    typeOptions: { minValue: 1 },
    description: 'Maximum characters per chunk',
  },
  {
    displayName: 'Chunk Overlap',
    name: 'chunkOverlap',
    type: 'number',
    default: 0,
    typeOptions: { minValue: 0 },
    description: 'Characters repeated between neighbouring chunks so context is not cut mid-thought',
  },
];

function splitterDescription(
  base: Pick<NodeTypeDescription, 'name' | 'displayName' | 'description' | 'icon'>,
  properties: NodeProperty[],
): NodeTypeDescription {
  return {
    ...base,
    group: ['transform'],
    version: 1,
    defaults: { name: base.displayName },
    inputs: [],
    outputs: ['ai_textSplitter'],
    outputNames: ['Text Splitter'],
    categories: ['AI', 'Text Splitters'],
    alias: ['chunk', 'split', 'rag'],
    properties,
  };
}

function readSizes(ctx: SupplyDataContext, itemIndex: number): SplitOptions {
  const options = {
    chunkSize: Number(ctx.getNodeParameter('chunkSize', itemIndex, 1000)),
    chunkOverlap: Number(ctx.getNodeParameter('chunkOverlap', itemIndex, 0)),
  };
  if (options.chunkOverlap >= options.chunkSize) {
    throw new NodeOperationError(ctx.getNode(), 'Chunk overlap must be smaller than the chunk size', {
      itemIndex,
    });
  }
  return options;
}

function supplySplitter(
  ctx: SupplyDataContext,
  split: (text: string) => string[] | Promise<string[]>,
): { response: AiTextSplitter } {
  return {
    response: {
      kind: 'textSplitter',
      async split(text) {
        try {
          const chunks = await split(text);
          ctx.logSubNodeRun({ textLength: text.length }, { chunks: chunks.length });
          return chunks;
        } catch (error) {
          ctx.logSubNodeRun({ textLength: text.length }, {}, error as Error);
          throw new NodeOperationError(ctx.getNode(), errorMessage(error));
        }
      },
    },
  };
}

const LANGUAGE_NAMES: Record<CodeLanguage, string> = {
  cpp: 'C++',
  go: 'Go',
  java: 'Java',
  js: 'JavaScript',
  php: 'PHP',
  proto: 'Protocol Buffers',
  python: 'Python',
  rst: 'reStructuredText',
  ruby: 'Ruby',
  rust: 'Rust',
  scala: 'Scala',
  swift: 'Swift',
  markdown: 'Markdown',
  latex: 'LaTeX',
  html: 'HTML',
};

export const TextSplitterRecursiveCharacterNode: NodeType = {
  description: splitterDescription(
    {
      name: 'ai.textSplitterRecursiveCharacter',
      displayName: 'Recursive Character Text Splitter',
      description: 'Splits by paragraphs, then lines, then words, keeping related text together',
      icon: 'lucide:scissors',
    },
    [
      ...sizeProperties,
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Split Code',
            name: 'splitCode',
            type: 'options',
            default: 'markdown',
            description: 'Split along the structure of a programming or markup language',
            options: CODE_LANGUAGES.map((value) => ({ name: LANGUAGE_NAMES[value], value })),
          },
          {
            displayName: 'Separators (JSON)',
            name: 'separators',
            type: 'json',
            default: '["\\n\\n", "\\n", " ", ""]',
            description: 'Tried in order, coarsest first',
          },
        ],
      },
    ],
  ),
  async supplyData(ctx, itemIndex) {
    const sizes = readSizes(ctx, itemIndex);
    const options = ctx.getNodeParameter('options', itemIndex, {}) as {
      separators?: unknown;
      splitCode?: unknown;
    };
    if (typeof options.splitCode === 'string' && options.splitCode) {
      const language = options.splitCode;
      if (!isCodeLanguage(language)) {
        throw new NodeOperationError(ctx.getNode(), `Unknown code language: ${language}`, { itemIndex });
      }
      return supplySplitter(ctx, (text) => splitCode(text, sizes, language));
    }
    let separators: string[] | undefined;
    if (options.separators) {
      const parsed =
        typeof options.separators === 'string' ? JSON.parse(options.separators) : options.separators;
      if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'string')) {
        throw new NodeOperationError(ctx.getNode(), 'Separators must be a JSON array of strings', {
          itemIndex,
        });
      }
      separators = parsed;
    }
    return supplySplitter(ctx, (text) => splitRecursively(text, sizes, separators));
  },
};

export const TextSplitterCharacterNode: NodeType = {
  description: splitterDescription(
    {
      name: 'ai.textSplitterCharacter',
      displayName: 'Character Text Splitter',
      description: 'Splits on one separator and merges the pieces into chunks',
      icon: 'lucide:scissors-line-dashed',
    },
    [
      {
        displayName: 'Separator',
        name: 'separator',
        type: 'string',
        default: '',
        description: 'Text to split on; empty splits between characters',
      },
      ...sizeProperties,
    ],
  ),
  async supplyData(ctx, itemIndex) {
    const sizes = readSizes(ctx, itemIndex);
    const separator = String(ctx.getNodeParameter('separator', itemIndex, '\n\n') ?? '');
    return supplySplitter(ctx, (text) => splitByCharacter(text, separator, sizes));
  },
};

export const TextSplitterTokenSplitterNode: NodeType = {
  description: splitterDescription(
    {
      name: 'ai.textSplitterTokenSplitter',
      displayName: 'Token Splitter',
      description: 'Splits by token count (cl100k_base) so chunks fit a model context',
      icon: 'lucide:scissors',
    },
    [
      {
        displayName: 'Chunk Size',
        name: 'chunkSize',
        type: 'number',
        default: 1000,
        typeOptions: { minValue: 1 },
        description: 'Maximum tokens per chunk',
      },
      {
        displayName: 'Chunk Overlap',
        name: 'chunkOverlap',
        type: 'number',
        default: 0,
        typeOptions: { minValue: 0 },
        description: 'Tokens repeated between neighbouring chunks',
      },
    ],
  ),
  async supplyData(ctx, itemIndex) {
    const sizes = readSizes(ctx, itemIndex);
    return supplySplitter(ctx, (text) => splitByTokens(text, sizes));
  },
};

export const textSplitterNodes: NodeType[] = [
  TextSplitterRecursiveCharacterNode,
  TextSplitterCharacterNode,
  TextSplitterTokenSplitterNode,
];
