/** RSS Feed Trigger: polls a feed over the guarded ctx.http and returns items newer than the last item date. */
import { type DataObject, type Item, NodeOperationError, type NodeType, type PollContext } from '@workflow/workflow';
import { parseFeed } from './web.nodes';

interface RssPollState {
  lastItemDate?: string;
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
    ],
  },

  async poll(ctx: PollContext) {
    const state = ctx.getWorkflowStaticData('node') as RssPollState;
    const url = String(ctx.getNodeParameter('feedUrl', 0, '') ?? '').trim();
    if (!url) {
      throw new NodeOperationError(ctx.getNode(), 'The parameter "URL" has to be set!');
    }
    const body = await ctx.helpers.httpRequest({
      url,
      method: 'GET',
      responseType: 'text',
      headers: {
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      },
    });
    let entries: DataObject[];
    try {
      entries = parseFeed(String(body)).entries;
    } catch (error) {
      throw new NodeOperationError(ctx.getNode(), `Could not read the feed: ${(error as Error).message}`);
    }
    const dated = entries
      .filter((e) => typeof e.isoDate === 'string')
      .sort((a, b) => Date.parse(String(b.isoDate)) - Date.parse(String(a.isoDate)));
    if (ctx.getMode() === 'manual') {
      const newest = dated[0] ?? entries[0];
      return newest ? [[{ json: newest } as Item]] : null;
    }
    if (dated.length === 0) return null;
    const newestDate = String(dated[0].isoDate);
    const last = state.lastItemDate;
    state.lastItemDate = last && Date.parse(last) > Date.parse(newestDate) ? last : newestDate;
    // the first poll after activation only records where the feed stands
    if (!last) return null;
    const fresh = dated.filter((e) => Date.parse(String(e.isoDate)) > Date.parse(last));
    return fresh.length ? [fresh.reverse().map((json) => ({ json }) as Item)] : null;
  },
};
