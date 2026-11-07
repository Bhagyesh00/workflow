/** SearXNG tool: web search through a SearXNG instance, sent by the guarded HTTP client. */
import type { DataObject, NodeType } from '@workflow/workflow';
import { createTool, QUERY_SCHEMA, toolNameOf } from '../../shared/tools';

const DESCRIPTION =
  'A meta search engine. Useful for when you need to answer questions about current events. Input should be a search query. Output is a JSON array of the query results';

const stripTags = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/** Pick the reply: results, else the first answer, else the infobox text, else suggestions. */
export function formatSearXngReply(body: unknown, numResults: number): string {
  const data = asRecord(body);
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length) {
    return results
      .slice(0, numResults)
      .map((r) => {
        const result = asRecord(r);
        return JSON.stringify({ title: result.title, link: result.url, snippet: result.content });
      })
      .join(',');
  }
  const answers = Array.isArray(data.answers) ? data.answers : [];
  if (answers.length) {
    const first = answers[0];
    const text = typeof first === 'string' ? first : asRecord(first).answer;
    if (text) return String(text);
  }
  const infoboxes = Array.isArray(data.infoboxes) ? data.infoboxes : [];
  const content = asRecord(infoboxes[0]).content;
  if (typeof content === 'string' && content.trim()) return stripTags(content);
  const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
  if (suggestions.length) return `Suggestions: ${suggestions.map(String).join(', ')}`;
  return 'No good results found.';
}

export const ToolSearXngNode: NodeType = {
  description: {
    name: 'ai.toolSearXng',
    displayName: 'SearXNG',
    description: 'Searches the web through a SearXNG instance',
    icon: 'simple:searxng',
    group: ['transform'],
    version: 1,
    defaults: { name: 'SearXNG' },
    inputs: [],
    outputs: ['ai_tool'],
    outputNames: ['Tool'],
    categories: ['AI', 'Tools'],
    credentials: [{ name: 'searXngApi', required: true }],
    properties: [
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        options: [
          {
            displayName: 'Number of Results',
            name: 'numResults',
            type: 'number',
            default: 10,
            typeOptions: { minValue: 1 },
            description: 'Maximum number of results returned to the model',
          },
          {
            displayName: 'Page Number',
            name: 'pageNumber',
            type: 'number',
            default: 1,
            typeOptions: { minValue: 1 },
          },
          { displayName: 'Language', name: 'language', type: 'string', default: 'en' },
          {
            displayName: 'Safe Search',
            name: 'safesearch',
            type: 'options',
            default: 0,
            options: [
              { name: 'None', value: 0 },
              { name: 'Moderate', value: 1 },
              { name: 'Strict', value: 2 },
            ],
          },
        ],
      },
    ],
  },
  async supplyData(ctx, itemIndex) {
    const options = asRecord(ctx.getNodeParameter('options', itemIndex, {}));
    const numResults = Math.max(1, Number(options.numResults ?? 10) || 10);
    const pageNumber = Math.max(1, Number(options.pageNumber ?? 1) || 1);
    const language = String(options.language ?? 'en') || 'en';
    const safesearch = Number(options.safesearch ?? 0) || 0;
    const creds = await ctx.getCredentials('searXngApi', itemIndex);
    const apiUrl = String(creds.apiUrl ?? '').replace(/\/+$/, '');
    if (!apiUrl) throw new Error('The SearXNG credential has no API URL');
    return {
      response: createTool(
        ctx,
        { name: toolNameOf(ctx), description: DESCRIPTION, parameters: QUERY_SCHEMA },
        async (args) => {
          const body = await ctx.helpers.httpRequestWithAuthentication(
            'searXngApi',
            {
              url: `${apiUrl}/search`,
              method: 'POST',
              qs: {
                q: String(args.query ?? ''),
                format: 'json',
                pageno: pageNumber,
                safesearch,
                language,
              },
              timeout: 15000,
              responseType: 'json',
              credentialScope: 'userUrl',
            },
            itemIndex,
          );
          return formatSearXngReply(body as DataObject, numResults);
        },
      ),
    };
  },
};
