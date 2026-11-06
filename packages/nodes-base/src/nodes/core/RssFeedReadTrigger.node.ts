/**
 * RSS Feed Trigger: polls a feed over the guarded ctx.http and returns the items dated after the last
 * check. With no stored check time the cutoff is now. A test run (manual mode) returns the first item
 * of the feed and keeps no state.
 */
import {
  type DataObject,
  type Item,
  NodeOperationError,
  type NodeType,
  type PollContext,
} from '@workflow/workflow';
import { pollTimesProperty } from '../../utils/poll-times';
import { parseFeed } from './web.nodes';

interface RssPollState {
  /** ISO time of the last poll */
  lastTimeChecked?: string;
}

/** true for a refused connection, however deep the HTTP client wrapped the socket error */
function connectionRefused(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 4) return false;
  const e = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (e.code === 'ECONNREFUSED') return true;
  if (connectionRefused(e.cause, depth + 1)) return true;
  return Array.isArray(e.errors) && e.errors.some((inner) => connectionRefused(inner, depth + 1));
}

export const RssFeedReadTriggerNode: NodeType = {
  description: {
    name: 'core.rssFeedReadTrigger',
    displayName: 'RSS Feed Trigger',
    description: 'Starts a run for each new item of a feed',
    icon: 'lucide:rss',
    iconColor: '#f26522',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'RSS Feed Trigger' },
    inputs: [],
    outputs: ['main'],
    polling: true,
    categories: ['Core', 'Triggers'],
    properties: [
      {
        displayName: 'Feed URL',
        name: 'feedUrl',
        type: 'string',
        default: 'https://blog.n8n.io/rss/',
        required: true,
        description: 'URL of the RSS feed to poll',
      },
      pollTimesProperty,
    ],
  },

  async poll(ctx: PollContext) {
    const state = ctx.getWorkflowStaticData('node') as RssPollState;
    const url = String(ctx.getNodeParameter('feedUrl', 0, '') ?? '').trim();
    if (!url) {
      throw new NodeOperationError(ctx.getNode(), 'The parameter "URL" has to be set!');
    }
    let body: unknown;
    try {
      body = await ctx.helpers.httpRequest({
        url,
        method: 'GET',
        responseType: 'text',
        headers: {
          accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
        },
      });
    } catch (error) {
      // the URL is not echoed: it can hold a user name and password
      if (connectionRefused(error))
        throw new NodeOperationError(
          ctx.getNode(),
          "Couldn't connect to the feed URL. Check that the URL is correct and that the server is running",
        );
      throw error;
    }
    let entries: DataObject[];
    try {
      entries = parseFeed(String(body)).entries;
    } catch (error) {
      throw new NodeOperationError(ctx.getNode(), `Could not read the feed: ${(error as Error).message}`);
    }
    if (ctx.getMode() === 'manual') {
      // a test run shows the first item of the feed and leaves the stored check time alone
      const first = entries[0];
      return first ? [[{ json: first } as Item]] : null;
    }
    const now = new Date().toISOString();
    const cutoff = Date.parse(state.lastTimeChecked ?? now);
    state.lastTimeChecked = now;
    const fresh = entries
      .filter((e) => typeof e.isoDate === 'string' && Date.parse(e.isoDate) > cutoff)
      .sort((a, b) => Date.parse(String(a.isoDate)) - Date.parse(String(b.isoDate)));
    return fresh.length ? [fresh.map((json) => ({ json }) as Item)] : null;
  },
};
