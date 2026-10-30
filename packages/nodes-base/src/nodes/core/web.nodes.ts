/** GraphQL and RSS Read: thin clients over the SSRF-guarded HTTP helpers. */
import {
  type DataObject,
  type HttpRequestOptions,
  isPlainObject,
  NodeApiError,
  NodeOperationError,
  type NodeType,
} from '@workflow/workflow';
import { XMLParser } from 'fast-xml-parser';
import { authCredentialDescriptions, authenticatedRequest, authProperties } from '../../utils/http';
import { keyValuePairs, mapItems, parseJsonObject } from '../../utils/utilities';

// ---------------------------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------------------------

export const GraphqlNode: NodeType = {
  description: {
    name: 'core.graphql',
    displayName: 'GraphQL',
    description: 'Send a GraphQL query or mutation to an API',
    icon: 'simple:graphql',
    iconColor: '#e10098',
    group: ['input'],
    version: 1,
    defaults: { name: 'GraphQL' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Developer tools'],
    alias: ['graphql', 'query', 'mutation', 'api', 'gql'],
    usableAsTool: true,
    credentials: authCredentialDescriptions,
    properties: [
      ...authProperties,
      {
        displayName: 'HTTP Request Method',
        name: 'requestMethod',
        type: 'options',
        default: 'POST',
        options: [
          { name: 'POST', value: 'POST' },
          { name: 'GET', value: 'GET', description: 'Query and variables are sent in the URL' },
        ],
      },
      {
        displayName: 'Endpoint',
        name: 'endpoint',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'https://api.example.com/graphql',
      },
      {
        displayName: 'Query',
        name: 'query',
        type: 'string',
        default: '',
        required: true,
        typeOptions: { rows: 8 },
        placeholder: 'query ($id: ID!) { order(id: $id) { id total } }',
      },
      {
        displayName: 'Variables',
        name: 'variables',
        type: 'json',
        default: '{}',
        typeOptions: { rows: 4 },
      },
      {
        displayName: 'Operation Name',
        name: 'operationName',
        type: 'string',
        default: '',
        description: 'Which operation to run when the query document defines several',
      },
      {
        displayName: 'Headers',
        name: 'headerParametersUi',
        type: 'fixedCollection',
        default: { parameter: [] },
        placeholder: 'Add header',
        typeOptions: { multipleValues: true },
        options: [
          {
            displayName: 'Header',
            name: 'parameter',
            values: [
              { displayName: 'Name', name: 'name', type: 'string', default: '' },
              { displayName: 'Value', name: 'value', type: 'string', default: '' },
            ],
          },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Continue on GraphQL Errors',
            name: 'ignoreGraphqlErrors',
            type: 'boolean',
            default: false,
            description: 'Whether a response with an "errors" list is still treated as success',
          },
          {
            displayName: 'Output Only Data',
            name: 'onlyData',
            type: 'boolean',
            default: false,
            description: 'Whether to output the "data" object instead of the whole response',
          },
          {
            displayName: 'Timeout',
            name: 'timeout',
            type: 'number',
            default: 30000,
            description: 'Milliseconds',
          },
        ],
      },
    ],
  },

  async execute(ctx) {
    return [
      await mapItems(ctx, async (i) => {
        const endpoint = String(ctx.getNodeParameter('endpoint', i, '') ?? '').trim();
        if (!/^https?:\/\//i.test(endpoint)) {
          throw new NodeOperationError(ctx.getNode(), 'The endpoint must be an http(s) URL', {
            itemIndex: i,
          });
        }
        const query = String(ctx.getNodeParameter('query', i, '') ?? '');
        if (!query.trim())
          throw new NodeOperationError(ctx.getNode(), 'The query is empty', { itemIndex: i });
        const variables = parseJsonObject(ctx, ctx.getNodeParameter('variables', i, '{}'), 'Variables', i);
        const operationName = String(ctx.getNodeParameter('operationName', i, '') ?? '') || undefined;
        const headers = keyValuePairs(
          (ctx.getNodeParameter('headerParametersUi', i, {}) as DataObject).parameter,
        );
        const options = ctx.getNodeParameter('options', i, {}) as DataObject;
        const method = ctx.getNodeParameter('requestMethod', i, 'POST') === 'GET' ? 'GET' : 'POST';
        const request: HttpRequestOptions = {
          url: endpoint,
          method,
          headers: {
            accept: 'application/json',
            ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])),
          },
          responseType: 'json',
          timeout: options.timeout ? Number(options.timeout) : undefined,
        };
        if (method === 'GET') {
          request.qs = {
            query,
            ...(Object.keys(variables).length ? { variables: JSON.stringify(variables) } : {}),
            ...(operationName ? { operationName } : {}),
          };
        } else {
          request.body = { query, variables, ...(operationName ? { operationName } : {}) };
          request.bodyType = 'json';
        }
        const response = (await authenticatedRequest(ctx, i, request)) as unknown;
        const body = typeof response === 'string' ? safeJson(response) : response;
        if (!isPlainObject(body)) {
          throw new NodeOperationError(ctx.getNode(), 'The GraphQL endpoint did not return a JSON object', {
            itemIndex: i,
          });
        }
        if (Array.isArray(body.errors) && body.errors.length && !options.ignoreGraphqlErrors) {
          const first = body.errors[0] as DataObject;
          throw new NodeApiError(ctx.getNode(), String(first?.message ?? 'GraphQL error'), {
            itemIndex: i,
            responseBody: body.errors,
            description:
              body.errors.length > 1 ? `${body.errors.length} errors; see the response` : undefined,
          });
        }
        return options.onlyData ? ((body.data as DataObject) ?? {}) : body;
      }),
    ];
  },
};

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------------------------
// RSS Read
// ---------------------------------------------------------------------------------------------

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (Array.isArray(value)) return text(value[0]);
  if (isPlainObject(value)) return text(value['#text'] ?? value._ ?? value['@_href']);
  return undefined;
}

function asList<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function snippet(html: string | undefined): string | undefined {
  if (!html) return undefined;
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Parse RSS 2.0, RSS 1.0 (RDF) and Atom feeds into flat entries. */
export function parseFeed(xml: string): { feed: DataObject; entries: DataObject[] } {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    removeNSPrefix: false,
    processEntities: true,
    htmlEntities: true,
    parseTagValue: false,
    trimValues: true,
  });
  const doc = parser.parse(xml) as DataObject;
  const rss = doc.rss as DataObject | undefined;
  const rdf = doc['rdf:RDF'] as DataObject | undefined;
  const atom = doc.feed as DataObject | undefined;

  if (rss || rdf) {
    const channel = (rss?.channel ?? rdf?.channel ?? {}) as DataObject;
    const items = asList((rss ? channel.item : rdf?.item) as DataObject | DataObject[]);
    return {
      feed: { title: text(channel.title), link: text(channel.link), description: text(channel.description) },
      entries: items.map((item) => {
        const content = text(item['content:encoded']) ?? text(item.description);
        const date = text(item.pubDate) ?? text(item['dc:date']);
        const guid = item.guid;
        return {
          title: text(item.title),
          link: text(item.link),
          pubDate: date,
          isoDate: isoDate(date),
          author: text(item['dc:creator']) ?? text(item.author),
          content,
          contentSnippet: snippet(content),
          guid: text(guid) ?? text(item.link),
          categories: asList(item.category as unknown)
            .map(text)
            .filter(Boolean),
          ...(isPlainObject(item.enclosure)
            ? {
                enclosure: {
                  url: item.enclosure['@_url'],
                  type: item.enclosure['@_type'],
                  length: item.enclosure['@_length'],
                },
              }
            : {}),
        };
      }),
    };
  }
  if (atom) {
    const linkOf = (links: unknown): string | undefined => {
      const list = asList(links as DataObject | DataObject[]);
      const alternate =
        list.find((l) => !isPlainObject(l) || !l['@_rel'] || l['@_rel'] === 'alternate') ?? list[0];
      return isPlainObject(alternate) ? (alternate['@_href'] as string | undefined) : text(alternate);
    };
    return {
      feed: { title: text(atom.title), link: linkOf(atom.link), description: text(atom.subtitle) },
      entries: asList(atom.entry as DataObject | DataObject[]).map((entry) => {
        const content = text(entry.content) ?? text(entry.summary);
        const date = text(entry.published) ?? text(entry.updated);
        const author = asList(entry.author as DataObject | DataObject[])[0];
        return {
          title: text(entry.title),
          link: linkOf(entry.link),
          pubDate: date,
          isoDate: isoDate(date),
          author: isPlainObject(author) ? text(author.name) : text(author),
          content,
          contentSnippet: snippet(content),
          guid: text(entry.id),
          categories: asList(entry.category as DataObject | DataObject[])
            .map((c) => (isPlainObject(c) ? (c['@_term'] as string) : text(c)))
            .filter(Boolean),
        };
      }),
    };
  }
  throw new Error('The document is not an RSS or Atom feed');
}

export const RssFeedReadNode: NodeType = {
  description: {
    name: 'core.rssFeedRead',
    displayName: 'RSS Read',
    description: 'Read the entries of an RSS or Atom feed',
    icon: 'lucide:rss',
    iconColor: '#f26522',
    group: ['input'],
    version: 1,
    defaults: { name: 'RSS Read' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Content'],
    alias: ['rss', 'atom', 'feed', 'news', 'blog', 'podcast'],
    usableAsTool: true,
    properties: [
      {
        displayName: 'URL',
        name: 'url',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'https://example.com/feed.xml',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Ignore SSL Issues (Insecure)',
            name: 'ignoreSSL',
            type: 'boolean',
            default: false,
          },
          {
            displayName: 'Include Feed Info',
            name: 'includeFeed',
            type: 'boolean',
            default: false,
            description: 'Whether each entry gets a "feed" field with the title and link of the feed',
          },
        ],
      },
    ],
  },
  async execute(ctx) {
    return [
      await mapItems(ctx, async (i) => {
        const url = String(ctx.getNodeParameter('url', i, '') ?? '').trim();
        if (!/^https?:\/\//i.test(url)) {
          throw new NodeOperationError(ctx.getNode(), 'The feed URL must be an http(s) URL', {
            itemIndex: i,
          });
        }
        const options = ctx.getNodeParameter('options', i, {}) as DataObject;
        const body = (await ctx.helpers.httpRequest({
          url,
          method: 'GET',
          responseType: 'text',
          headers: {
            accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
          },
          skipSslCertificateValidation: Boolean(options.ignoreSSL),
        })) as string;
        let parsed: ReturnType<typeof parseFeed>;
        try {
          parsed = parseFeed(String(body));
        } catch (error) {
          throw new NodeOperationError(
            ctx.getNode(),
            `Could not read the feed: ${(error as Error).message}`,
            { itemIndex: i },
          );
        }
        return parsed.entries.map((entry) => (options.includeFeed ? { ...entry, feed: parsed.feed } : entry));
      }),
    ];
  },
};
