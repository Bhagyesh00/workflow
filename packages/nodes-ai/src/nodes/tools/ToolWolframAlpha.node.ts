/** Wolfram|Alpha tool: answers from the Wolfram|Alpha LLM API; the App ID goes in a header, never the URL. */
import type { NodeType } from '@workflow/workflow';
import { createTool, QUERY_SCHEMA, toolNameOf } from '../../shared/tools';

const DESCRIPTION =
  'A wrapper around Wolfram Alpha. Useful for when you need to answer questions about Math, Science, Technology, Culture, Society and Everyday Life. Input should be a search query.';

export const ToolWolframAlphaNode: NodeType = {
  description: {
    name: 'ai.toolWolframAlpha',
    displayName: 'Wolfram|Alpha',
    description: 'Answers math, science and data questions with Wolfram|Alpha',
    icon: 'simple:wolfram',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Wolfram|Alpha' },
    inputs: [],
    outputs: ['ai_tool'],
    outputNames: ['Tool'],
    categories: ['AI', 'Tools'],
    credentials: [{ name: 'wolframAlphaApi', required: true }],
    properties: [],
  },
  async supplyData(ctx, itemIndex) {
    return {
      response: createTool(
        ctx,
        { name: toolNameOf(ctx), description: DESCRIPTION, parameters: QUERY_SCHEMA },
        async (args) => {
          const answer = await ctx.helpers.httpRequestWithAuthentication(
            'wolframAlphaApi',
            {
              url: 'https://www.wolframalpha.com/api/v1/llm-api',
              method: 'GET',
              qs: { input: String(args.query ?? '') },
              timeout: 30000,
              responseType: 'text',
            },
            itemIndex,
          );
          return typeof answer === 'string' ? answer : JSON.stringify(answer);
        },
      ),
    };
  },
};
