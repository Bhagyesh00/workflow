/** Wikipedia tool: looks up articles on en.wikipedia.org (top 3 results, 4000 characters each). */
import type { NodeType } from '@workflow/workflow';
import { createTool, QUERY_SCHEMA, toolNameOf } from '../../shared/tools';

const DESCRIPTION =
  'A tool for interacting with and fetching data from the Wikipedia API. Input should be a search query.';
const API = 'https://en.wikipedia.org/w/api.php';
const TOP_RESULTS = 3;
const MAX_CHARS = 4000;
const NONE = 'No good Wikipedia Search Result was found';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

export const ToolWikipediaNode: NodeType = {
  description: {
    name: 'ai.toolWikipedia',
    displayName: 'Wikipedia',
    description: 'Looks up Wikipedia articles',
    icon: 'simple:wikipedia',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Wikipedia' },
    inputs: [],
    outputs: ['ai_tool'],
    outputNames: ['Tool'],
    categories: ['AI', 'Tools'],
    properties: [],
  },
  async supplyData(ctx) {
    return {
      response: createTool(
        ctx,
        { name: toolNameOf(ctx), description: DESCRIPTION, parameters: QUERY_SCHEMA },
        async (args) => {
          const query = String(args.query ?? '').trim();
          if (!query) return NONE;
          const search = asRecord(
            await ctx.helpers.httpRequest({
              url: API,
              method: 'GET',
              qs: { action: 'query', list: 'search', srsearch: query, srlimit: TOP_RESULTS, format: 'json' },
              timeout: 15000,
              responseType: 'json',
            }),
          );
          const hits = asRecord(search.query).search;
          const titles = (Array.isArray(hits) ? hits : [])
            .slice(0, TOP_RESULTS)
            .map((h) => String(asRecord(h).title ?? ''))
            .filter(Boolean);
          const pages: string[] = [];
          for (const title of titles) {
            const page = asRecord(
              await ctx.helpers.httpRequest({
                url: API,
                method: 'GET',
                qs: {
                  action: 'query',
                  prop: 'extracts',
                  explaintext: 1,
                  redirects: 1,
                  titles: title,
                  format: 'json',
                },
                timeout: 15000,
                responseType: 'json',
              }),
            );
            const entries = Object.values(asRecord(asRecord(page.query).pages));
            const extract = String(asRecord(entries[0]).extract ?? '').trim();
            if (extract) pages.push(`Page: ${title}\nSummary: ${extract.slice(0, MAX_CHARS)}`);
          }
          return pages.length ? pages.join('\n\n') : NONE;
        },
      ),
    };
  },
};
