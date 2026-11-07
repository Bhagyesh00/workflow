/** Cohere reranker: reorders documents by relevance to the query on `/v2/rerank`, keeps the Top N. */
import type { AiDocument, AiReranker, NodeType } from '@workflow/workflow';
import { COHERE_DEFAULT_BASE_URL } from '../../providers/cohere';
import { trimSlash } from '../../shared/chat-model';
import { withRetries } from '../../shared/retry';

const RERANK_MODELS = ['rerank-v3.5', 'rerank-english-v3.0', 'rerank-multilingual-v3.0'];
/** Cohere accepts about 1,000 documents per request */
const MAX_DOCUMENTS = 1000;
const MAX_RETRIES = 2;

interface RerankReply {
  results?: Array<{ index?: number; relevance_score?: number }>;
}

export const RerankerCohereNode: NodeType = {
  description: {
    name: 'ai.rerankerCohere',
    displayName: 'Reranker Cohere',
    description: 'Reorders documents from a vector store by their relevance to the query',
    icon: 'simple:cohere',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Reranker Cohere' },
    inputs: [],
    outputs: ['ai_reranker'],
    outputNames: ['Reranker'],
    credentials: [{ name: 'cohereApi', required: true }],
    categories: ['AI', 'Rerankers'],
    alias: ['rerank', 'rag'],
    properties: [
      {
        displayName: 'Model',
        name: 'modelName',
        type: 'options',
        default: 'rerank-v3.5',
        options: RERANK_MODELS.map((m) => ({ name: m, value: m })),
        description: 'The model that scores each document against the query',
      },
      {
        displayName: 'Top N',
        name: 'topN',
        type: 'number',
        default: 3,
        typeOptions: { minValue: 1 },
        description: 'How many of the best documents to keep',
      },
    ],
  },
  async supplyData(ctx, itemIndex) {
    const creds = await ctx.getCredentials('cohereApi', itemIndex);
    const model = String(ctx.getNodeParameter('modelName', itemIndex, 'rerank-v3.5')).trim() || 'rerank-v3.5';
    const topN = Math.max(1, Math.floor(Number(ctx.getNodeParameter('topN', itemIndex, 3)) || 3));
    const baseUrl = trimSlash(String(creds.url || COHERE_DEFAULT_BASE_URL));

    const reranker: AiReranker = {
      kind: 'reranker',
      async rerank(query, documents, options) {
        if (!documents.length) return [];
        const sent = documents.slice(0, MAX_DOCUMENTS);
        // Document text is untrusted data. It goes out only as plain strings in `documents`; this call
        // builds no prompt (Cohere only scores each text), so there is nothing to wrap. Order and
        // metadata come from our own copies, never from text.
        const input = { model, query, documents: sent.length, topN };
        try {
          const body = (await withRetries(
            () =>
              ctx.helpers.httpRequestWithAuthentication(
                'cohereApi',
                {
                  method: 'POST',
                  url: `${baseUrl}/v2/rerank`,
                  body: {
                    model,
                    query,
                    documents: sent.map((d) => d.pageContent),
                    top_n: topN,
                  },
                },
                itemIndex,
              ),
            { maxRetries: MAX_RETRIES, signal: options?.signal ?? ctx.signal },
          )) as RerankReply;
          const ranked: Array<{ document: AiDocument; score: number }> = [];
          for (const result of body?.results ?? []) {
            const source = typeof result.index === 'number' ? sent[result.index] : undefined;
            if (!source || typeof result.relevance_score !== 'number') continue;
            ranked.push({
              document: {
                pageContent: source.pageContent,
                metadata: { ...source.metadata, relevanceScore: result.relevance_score },
              },
              score: result.relevance_score,
            });
          }
          const kept = ranked.slice(0, topN);
          ctx.logSubNodeRun(input, { documents: kept.length });
          return kept;
        } catch (error) {
          ctx.logSubNodeRun(input, {}, error as Error);
          throw error;
        }
      },
    };
    return { response: reranker };
  },
};
