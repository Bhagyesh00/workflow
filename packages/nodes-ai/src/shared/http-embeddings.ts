/**
 * Provider-neutral embeddings over HTTP. Texts are sent in batches; each batch is retried on rate
 * limits and server errors and recorded in the AI log. It lives apart from the node files, so a new
 * embedding node imports no multi-node file.
 */
import type { AiEmbeddings, HttpRequestOptions, SupplyDataContext } from '@workflow/workflow';
import { withRetries } from './retry';

export type EmbedPurpose = 'document' | 'query';

export interface EmbeddingsConfig {
  credentialType: string;
  model: string;
  itemIndex: number;
  batchSize: number;
  maxRetries: number;
  timeoutMs?: number;
  dimensions?: number;
  request(texts: string[], purpose: EmbedPurpose): HttpRequestOptions;
  parse(body: unknown, count: number): number[][];
}

export class HttpEmbeddings implements AiEmbeddings {
  readonly kind = 'embeddings' as const;
  dimensions?: number;

  constructor(
    private readonly ctx: SupplyDataContext,
    private readonly config: EmbeddingsConfig,
  ) {
    this.dimensions = config.dimensions;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += this.config.batchSize) {
      vectors.push(...(await this.embed(texts.slice(start, start + this.config.batchSize), 'document')));
    }
    return vectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    return (await this.embed([text], 'query'))[0];
  }

  private async embed(texts: string[], purpose: EmbedPurpose): Promise<number[][]> {
    if (!texts.length) return [];
    const input = { model: this.config.model, texts: texts.length, purpose };
    try {
      const body = await withRetries(
        () =>
          this.ctx.helpers.httpRequestWithAuthentication(
            this.config.credentialType,
            { ...this.config.request(texts, purpose), method: 'POST', timeout: this.config.timeoutMs },
            this.config.itemIndex,
          ),
        { maxRetries: this.config.maxRetries, signal: this.ctx.signal },
      );
      const vectors = this.config.parse(body, texts.length);
      if (vectors.length !== texts.length || vectors.some((v) => !Array.isArray(v) || !v.length)) {
        throw new Error(`The embeddings API returned ${vectors.length} vectors for ${texts.length} texts`);
      }
      this.dimensions ??= vectors[0].length;
      this.ctx.logSubNodeRun(input, { vectors: vectors.length, dimensions: vectors[0].length });
      return vectors;
    } catch (error) {
      this.ctx.logSubNodeRun(input, {}, error as Error);
      throw error;
    }
  }
}
