/** MultiQuery Retriever: the model rewrites the query several ways, the results are merged. */
import type { AiDocument, AiRetriever, NodeType } from '@workflow/workflow';
import { getChatModel, getRetriever } from '../../shared/ai-inputs';
import { messageText } from '../../shared/utils';

export const RetrieverMultiQueryNode: NodeType = {
  description: {
    name: 'ai.retrieverMultiQuery',
    displayName: 'MultiQuery Retriever',
    description: 'Asks the model for several versions of the query and merges the documents found',
    icon: 'lucide:list-tree',
    group: ['transform'],
    version: 1,
    defaults: { name: 'MultiQuery Retriever' },
    inputs: [
      { type: 'ai_languageModel', displayName: 'Model', required: true, maxConnections: 1 },
      { type: 'ai_retriever', displayName: 'Retriever', required: true, maxConnections: 1 },
    ],
    outputs: ['ai_retriever'],
    outputNames: ['Retriever'],
    categories: ['AI', 'Retrievers'],
    alias: ['rag', 'search'],
    properties: [
      {
        displayName: 'Query Count',
        name: 'queryCount',
        type: 'number',
        default: 3,
        typeOptions: { minValue: 1, maxValue: 20 },
        description: 'How many versions of the query the model writes',
      },
    ],
  },
  async supplyData(ctx, itemIndex) {
    const model = await getChatModel(ctx, itemIndex);
    const base = (await getRetriever(ctx, itemIndex))!;
    const raw = Math.floor(Number(ctx.getNodeParameter('queryCount', itemIndex, 3)));
    const count = Number.isFinite(raw) ? Math.min(20, Math.max(1, raw)) : 3;
    const retriever: AiRetriever = {
      kind: 'retriever',
      async retrieve(query) {
        const response = await model.chat({
          messages: [
            {
              role: 'system',
              content: `You rewrite a search question to help find documents in a vector database. Write ${count} different versions of the user's question, each from another angle. Put one version on each line and write nothing else.`,
            },
            { role: 'user', content: query },
          ],
          signal: ctx.signal,
        });
        // model output is query text only: one line is one query, nothing else is read from it
        const lines = messageText(response.message.content)
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        const queries = [...new Set(lines)].slice(0, count);
        const seen = new Set<string>();
        const documents: AiDocument[] = [];
        for (const text of queries) {
          for (const document of await base.retrieve(text)) {
            const key = JSON.stringify([document.pageContent, document.metadata]);
            if (seen.has(key)) continue;
            seen.add(key);
            documents.push(document);
          }
        }
        ctx.logSubNodeRun({ query, queries }, { documents: documents.length });
        return documents;
      },
    };
    return { response: retriever };
  },
};
