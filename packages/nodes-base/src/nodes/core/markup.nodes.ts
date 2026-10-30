/** Markup conversions: HTML (extract with CSS selectors, build tables), XML <-> JSON, Markdown <-> HTML. */
import {
  type DataObject,
  deepCopy,
  type ExecuteContext,
  type Item,
  isPlainObject,
  NodeOperationError,
  type NodeType,
} from '@workflow/workflow';
import { load } from 'cheerio';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { Marked } from 'marked';
import TurndownService from 'turndown';
import { getField, ItemList, mapItems, setField } from '../../utils/utilities';

// ---------------------------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------------------------

interface ExtractionValue {
  key: string;
  cssSelector: string;
  returnValue: 'text' | 'html' | 'attribute' | 'value';
  attribute?: string;
  skipSelectors?: string;
  returnArray?: boolean;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `key="value"` attribute lists typed by users: only plain name/value pairs survive. */
function safeAttributes(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const attrs: string[] = [];
  for (const match of text.matchAll(
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
  )) {
    const name = match[1].toLowerCase();
    if (name.startsWith('on')) continue; // no event handler attributes
    attrs.push(`${name}="${escapeHtml(match[3] ?? match[4] ?? match[5] ?? '')}"`);
  }
  return attrs.length ? ` ${attrs.join(' ')}` : '';
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Build an HTML table from items (header row = union of top-level keys). Values are escaped. */
export function itemsToHtmlTable(rows: DataObject[], options: DataObject = {}): string {
  const headers: string[] = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!headers.includes(key)) headers.push(key);
  const label = (h: string) => (options.capitalize ? h.charAt(0).toUpperCase() + h.slice(1) : h);
  const style = options.customStyling
    ? ''
    : '<style>table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:4px 8px;text-align:left}</style>';
  const caption = options.caption ? `<caption>${escapeHtml(options.caption)}</caption>` : '';
  const head = `<thead><tr${safeAttributes(options.headerAttributes)}>${headers
    .map((h) => `<th>${escapeHtml(label(h))}</th>`)
    .join('')}</tr></thead>`;
  const body = rows
    .map(
      (row) =>
        `<tr${safeAttributes(options.rowAttributes)}>${headers
          .map((h) => `<td${safeAttributes(options.cellAttributes)}>${escapeHtml(cellText(row[h]))}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  return `${style}<table${safeAttributes(options.tableAttributes)}>${caption}${head}<tbody>${body}</tbody></table>`;
}

async function readSource(
  ctx: ExecuteContext,
  i: number,
  item: Item,
  property: string,
  source: string,
): Promise<string> {
  if (source === 'binary')
    return Buffer.from(await ctx.helpers.getBinaryDataBuffer(i, property)).toString('utf8');
  const value = getField(item.json, property);
  if (value === undefined) {
    throw new NodeOperationError(ctx.getNode(), `Item has no field "${property}"`, {
      itemIndex: i,
      parameter: 'dataPropertyName',
    });
  }
  return typeof value === 'string' ? value : String(value);
}

export const HtmlNode: NodeType = {
  description: {
    name: 'core.html',
    displayName: 'HTML',
    description: 'Extract content from HTML with CSS selectors, or turn items into an HTML table',
    icon: 'lucide:file-code',
    group: ['transform'],
    version: 1,
    defaults: { name: 'HTML' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Data transformation'],
    alias: ['scrape', 'css selector', 'parse html', 'extract', 'web page', 'table'],
    subtitle: '={{ $parameter.operation }}',
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'extractHtmlContent',
        noDataExpression: true,
        options: [
          { name: 'Extract HTML Content', value: 'extractHtmlContent', action: 'Extract HTML content' },
          {
            name: 'Convert to HTML Table',
            value: 'convertToHtmlTable',
            action: 'Convert items to an HTML table',
          },
        ],
      },
      {
        displayName: 'Source Data',
        name: 'sourceData',
        type: 'options',
        default: 'json',
        displayOptions: { show: { operation: ['extractHtmlContent'] } },
        options: [
          { name: 'JSON', value: 'json' },
          { name: 'Binary', value: 'binary' },
        ],
      },
      {
        displayName: 'Field Containing HTML',
        name: 'dataPropertyName',
        type: 'string',
        default: 'data',
        displayOptions: { show: { operation: ['extractHtmlContent'] } },
        description: 'JSON field, or binary property, holding the HTML',
      },
      {
        displayName: 'Extraction Values',
        name: 'extractionValues',
        type: 'fixedCollection',
        default: { values: [] },
        placeholder: 'Add value',
        typeOptions: { multipleValues: true },
        displayOptions: { show: { operation: ['extractHtmlContent'] } },
        options: [
          {
            displayName: 'Values',
            name: 'values',
            values: [
              { displayName: 'Key', name: 'key', type: 'string', default: '', placeholder: 'title' },
              {
                displayName: 'CSS Selector',
                name: 'cssSelector',
                type: 'string',
                default: '',
                placeholder: 'h1.title',
              },
              {
                displayName: 'Return Value',
                name: 'returnValue',
                type: 'options',
                default: 'text',
                options: [
                  { name: 'Text', value: 'text', description: 'Text content without tags' },
                  { name: 'HTML', value: 'html', description: 'Inner HTML' },
                  {
                    name: 'Attribute',
                    value: 'attribute',
                    description: 'Value of an attribute such as href',
                  },
                  { name: 'Value', value: 'value', description: 'Value of an input, select or textarea' },
                ],
              },
              {
                displayName: 'Attribute',
                name: 'attribute',
                type: 'string',
                default: '',
                placeholder: 'href',
                displayOptions: { show: { returnValue: ['attribute'] } },
              },
              {
                displayName: 'Skip Selectors',
                name: 'skipSelectors',
                type: 'string',
                default: '',
                placeholder: 'img, .ad',
                description: 'Elements to ignore inside the match (text only)',
                displayOptions: { show: { returnValue: ['text'] } },
              },
              {
                displayName: 'Return Array',
                name: 'returnArray',
                type: 'boolean',
                default: false,
                description: 'Whether to return every match as a list instead of the combined first match',
              },
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
            displayName: 'Trim Values',
            name: 'trimValues',
            type: 'boolean',
            default: true,
            displayOptions: { show: { '/operation': ['extractHtmlContent'] } },
          },
          {
            displayName: 'Clean Up Text',
            name: 'cleanUpText',
            type: 'boolean',
            default: true,
            description: 'Whether to collapse whitespace and line breaks in text values',
            displayOptions: { show: { '/operation': ['extractHtmlContent'] } },
          },
          {
            displayName: 'Capitalize Headers',
            name: 'capitalize',
            type: 'boolean',
            default: false,
            displayOptions: { show: { '/operation': ['convertToHtmlTable'] } },
          },
          {
            displayName: 'Custom Styling',
            name: 'customStyling',
            type: 'boolean',
            default: false,
            description: 'Whether to leave out the default table styles',
            displayOptions: { show: { '/operation': ['convertToHtmlTable'] } },
          },
          {
            displayName: 'Caption',
            name: 'caption',
            type: 'string',
            default: '',
            displayOptions: { show: { '/operation': ['convertToHtmlTable'] } },
          },
          ...(['tableAttributes', 'headerAttributes', 'rowAttributes', 'cellAttributes'] as const).map(
            (name) => ({
              displayName: `${name.replace('Attributes', '')[0].toUpperCase()}${name.replace('Attributes', '').slice(1)} Attributes`,
              name,
              type: 'string' as const,
              default: '',
              placeholder: 'class="report"',
              displayOptions: { show: { '/operation': ['convertToHtmlTable'] } },
            }),
          ),
        ],
      },
    ],
  },

  async execute(ctx) {
    const operation = ctx.getNodeParameter('operation', 0) as string;
    const items = ctx.getInputData();
    if (operation === 'convertToHtmlTable') {
      const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
      const table = itemsToHtmlTable(
        items.map((i) => i.json),
        options,
      );
      return [[{ json: { table }, pairedItem: items.map((_, i) => ({ item: i })) }]];
    }
    return [
      await mapItems(ctx, async (i, item) => {
        const source = ctx.getNodeParameter('sourceData', i, 'json') as string;
        const property = ctx.getNodeParameter('dataPropertyName', i, 'data') as string;
        const html = await readSource(ctx, i, item, property, source);
        const values = ((ctx.getNodeParameter('extractionValues', i, {}) as DataObject).values ??
          []) as ExtractionValue[];
        const trim = ctx.getNodeParameter('options.trimValues', i, true) !== false;
        const clean = ctx.getNodeParameter('options.cleanUpText', i, true) !== false;
        const $ = load(html);
        const json: DataObject = {};
        const finish = (v: string | undefined) => {
          if (v === undefined) return undefined;
          let out = v;
          if (clean) out = out.replace(/\s+/g, ' ');
          return trim ? out.trim() : out;
        };
        for (const v of values) {
          if (!v.key || !v.cssSelector) continue;
          let elements: ReturnType<typeof $>;
          try {
            elements = $(v.cssSelector);
          } catch (error) {
            throw new NodeOperationError(ctx.getNode(), `Invalid CSS selector "${v.cssSelector}"`, {
              itemIndex: i,
              description: (error as Error).message,
            });
          }
          const read = (el: Parameters<typeof $>[0]) => {
            const node = $(el);
            switch (v.returnValue) {
              case 'html':
                return finish(node.html() ?? '');
              case 'attribute':
                return finish(node.attr(v.attribute ?? ''));
              case 'value':
                return finish(node.val() === undefined ? undefined : String(node.val()));
              default: {
                const copy = node.clone();
                copy.find('script, style, noscript').remove();
                if (v.skipSelectors) copy.find(v.skipSelectors).remove();
                return finish(copy.text());
              }
            }
          };
          json[v.key] = v.returnArray
            ? elements.toArray().map((el) => read(el) ?? null)
            : elements.length
              ? (read(elements.first().get(0)!) ?? null)
              : null;
        }
        return json;
      }),
    ];
  },
};

// ---------------------------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------------------------

export const XmlNode: NodeType = {
  description: {
    name: 'core.xml',
    displayName: 'XML',
    description: 'Convert between XML and JSON',
    icon: 'lucide:file-code-2',
    group: ['transform'],
    version: 1,
    defaults: { name: 'XML' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Data transformation'],
    alias: ['xml', 'soap', 'parse xml', 'json to xml', 'convert'],
    subtitle: '={{ $parameter.mode }}',
    properties: [
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        default: 'xmlToJson',
        noDataExpression: true,
        options: [
          { name: 'XML to JSON', value: 'xmlToJson', action: 'Convert XML to JSON' },
          { name: 'JSON to XML', value: 'jsonToxml', action: 'Convert JSON to XML' },
        ],
      },
      {
        displayName: 'Property Name',
        name: 'dataPropertyName',
        type: 'string',
        default: 'data',
        description: 'Field that holds the XML to read (XML to JSON) or receives the XML (JSON to XML)',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Attribute Key',
            name: 'attrkey',
            type: 'string',
            default: '$',
            description: 'Key that groups the attributes of an element',
          },
          {
            displayName: 'Character Key',
            name: 'charkey',
            type: 'string',
            default: '_',
            description: 'Key for the text of an element that also has attributes or children',
          },
          {
            displayName: 'Explicit Array',
            name: 'explicitArray',
            type: 'boolean',
            default: false,
            description: 'Whether child elements always become lists, even when there is only one',
            displayOptions: { show: { '/mode': ['xmlToJson'] } },
          },
          {
            displayName: 'Ignore Attributes',
            name: 'ignoreAttrs',
            type: 'boolean',
            default: false,
            displayOptions: { show: { '/mode': ['xmlToJson'] } },
          },
          {
            displayName: 'Parse Numbers and Booleans',
            name: 'parseValues',
            type: 'boolean',
            default: false,
            displayOptions: { show: { '/mode': ['xmlToJson'] } },
          },
          {
            displayName: 'Trim',
            name: 'trim',
            type: 'boolean',
            default: true,
            displayOptions: { show: { '/mode': ['xmlToJson'] } },
          },
          {
            displayName: 'Root Name',
            name: 'rootName',
            type: 'string',
            default: 'root',
            description: 'Root element used when the item has more than one top-level field',
            displayOptions: { show: { '/mode': ['jsonToxml'] } },
          },
          {
            displayName: 'Headless',
            name: 'headless',
            type: 'boolean',
            default: false,
            description: 'Whether to leave out the <?xml ...?> declaration',
            displayOptions: { show: { '/mode': ['jsonToxml'] } },
          },
          {
            displayName: 'Pretty Print',
            name: 'pretty',
            type: 'boolean',
            default: true,
            displayOptions: { show: { '/mode': ['jsonToxml'] } },
          },
        ],
      },
    ],
  },

  async execute(ctx) {
    return [
      await mapItems(ctx, async (i, item) => {
        const mode = ctx.getNodeParameter('mode', i) as string;
        const property = ctx.getNodeParameter('dataPropertyName', i, 'data') as string;
        const options = ctx.getNodeParameter('options', i, {}) as DataObject;
        const attrkey = String(options.attrkey ?? '$') || '$';
        const charkey = String(options.charkey ?? '_') || '_';

        if (mode === 'jsonToxml') {
          const json = deepCopy(item.json);
          const keys = Object.keys(json);
          const doc =
            keys.length === 1 && isPlainObject(json[keys[0]])
              ? json
              : { [String(options.rootName || 'root')]: json };
          const builder = new XMLBuilder({
            attributesGroupName: attrkey,
            attributeNamePrefix: '',
            ignoreAttributes: false,
            textNodeName: charkey,
            format: options.pretty !== false,
            indentBy: '  ',
            suppressEmptyNode: false,
          });
          const body = builder.build(doc) as string;
          const xml = options.headless
            ? body
            : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
          return { [property]: xml };
        }

        const xml = getField(item.json, property);
        if (typeof xml !== 'string') {
          throw new NodeOperationError(ctx.getNode(), `Item has no XML text in field "${property}"`, {
            itemIndex: i,
            parameter: 'dataPropertyName',
          });
        }
        const explicitArray = Boolean(options.explicitArray);
        const parser = new XMLParser({
          ignoreAttributes: Boolean(options.ignoreAttrs),
          attributesGroupName: attrkey,
          attributeNamePrefix: '',
          textNodeName: charkey,
          parseTagValue: Boolean(options.parseValues),
          parseAttributeValue: Boolean(options.parseValues),
          trimValues: options.trim !== false,
          processEntities: true,
          htmlEntities: false,
          isArray: explicitArray ? (_name, _path, _isLeaf, isAttribute) => !isAttribute : undefined,
        });
        let parsed: DataObject;
        try {
          parsed = parser.parse(xml, true) as DataObject;
        } catch (error) {
          throw new NodeOperationError(ctx.getNode(), 'The XML is not valid', {
            itemIndex: i,
            description: (error as Error).message,
          });
        }
        const json = deepCopy(item.json);
        // the XML replaces the field it came from when it is the only field; otherwise merge
        return Object.keys(json).length === 1 && property in json ? parsed : { ...json, ...parsed };
      }),
    ];
  },
};

// ---------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------

export const MarkdownNode: NodeType = {
  description: {
    name: 'core.markdown',
    displayName: 'Markdown',
    description: 'Convert between Markdown and HTML',
    icon: 'lucide:file-type',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Markdown' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Data transformation'],
    alias: ['markdown', 'md', 'html', 'convert', 'rich text'],
    subtitle: '={{ $parameter.mode }}',
    properties: [
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        default: 'htmlToMarkdown',
        noDataExpression: true,
        options: [
          { name: 'Markdown to HTML', value: 'markdownToHtml', action: 'Convert Markdown to HTML' },
          { name: 'HTML to Markdown', value: 'htmlToMarkdown', action: 'Convert HTML to Markdown' },
        ],
      },
      {
        displayName: 'Markdown',
        name: 'markdown',
        type: 'string',
        default: '',
        required: true,
        typeOptions: { rows: 4 },
        displayOptions: { show: { mode: ['markdownToHtml'] } },
      },
      {
        displayName: 'HTML',
        name: 'html',
        type: 'string',
        default: '',
        required: true,
        typeOptions: { rows: 4 },
        displayOptions: { show: { mode: ['htmlToMarkdown'] } },
      },
      {
        displayName: 'Destination Key',
        name: 'destinationKey',
        type: 'string',
        default: 'data',
        description: 'Field that receives the result (dot notation creates nested fields)',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'GitHub Flavored Markdown',
            name: 'gfm',
            type: 'boolean',
            default: true,
            description: 'Whether to support tables, strikethrough and autolinks',
            displayOptions: { show: { '/mode': ['markdownToHtml'] } },
          },
          {
            displayName: 'Line Breaks',
            name: 'breaks',
            type: 'boolean',
            default: false,
            description: 'Whether single line breaks become <br>',
            displayOptions: { show: { '/mode': ['markdownToHtml'] } },
          },
          {
            displayName: 'Heading Style',
            name: 'headingStyle',
            type: 'options',
            default: 'atx',
            options: [
              { name: '# Heading', value: 'atx' },
              { name: 'Underlined (Setext)', value: 'setext' },
            ],
            displayOptions: { show: { '/mode': ['htmlToMarkdown'] } },
          },
          {
            displayName: 'Bullet Marker',
            name: 'bulletListMarker',
            type: 'options',
            default: '-',
            options: ['-', '*', '+'].map((m) => ({ name: m, value: m })),
            displayOptions: { show: { '/mode': ['htmlToMarkdown'] } },
          },
          {
            displayName: 'Code Block Style',
            name: 'codeBlockStyle',
            type: 'options',
            default: 'fenced',
            options: [
              { name: 'Fenced (```)', value: 'fenced' },
              { name: 'Indented', value: 'indented' },
            ],
            displayOptions: { show: { '/mode': ['htmlToMarkdown'] } },
          },
          {
            displayName: 'Emphasis Delimiter',
            name: 'emDelimiter',
            type: 'options',
            default: '_',
            options: ['_', '*'].map((m) => ({ name: m, value: m })),
            displayOptions: { show: { '/mode': ['htmlToMarkdown'] } },
          },
          {
            displayName: 'Strong Delimiter',
            name: 'strongDelimiter',
            type: 'options',
            default: '**',
            options: ['**', '__'].map((m) => ({ name: m, value: m })),
            displayOptions: { show: { '/mode': ['htmlToMarkdown'] } },
          },
        ],
      },
    ],
  },

  async execute(ctx) {
    return [
      await mapItems(ctx, async (i, item) => {
        const mode = ctx.getNodeParameter('mode', i) as string;
        const destination = String(ctx.getNodeParameter('destinationKey', i, 'data') || 'data');
        const options = ctx.getNodeParameter('options', i, {}) as DataObject;
        let result: string;
        if (mode === 'markdownToHtml') {
          const markdown = String(ctx.getNodeParameter('markdown', i, '') ?? '');
          const marked = new Marked({
            gfm: options.gfm !== false,
            breaks: Boolean(options.breaks),
            async: false,
          });
          result = marked.parse(markdown) as string;
        } else {
          const html = String(ctx.getNodeParameter('html', i, '') ?? '');
          const turndown = new TurndownService({
            headingStyle: (options.headingStyle as 'atx' | 'setext') ?? 'atx',
            bulletListMarker: (options.bulletListMarker as '-' | '*' | '+') ?? '-',
            codeBlockStyle: (options.codeBlockStyle as 'fenced' | 'indented') ?? 'fenced',
            emDelimiter: (options.emDelimiter as '_' | '*') ?? '_',
            strongDelimiter: (options.strongDelimiter as '**' | '__') ?? '**',
          });
          turndown.remove(['script', 'style']);
          result = turndown.turndown(html);
        }
        const json = deepCopy(item.json);
        setField(json, destination, result);
        return new ItemList([{ json, ...(item.binary ? { binary: item.binary } : {}) }]);
      }),
    ];
  },
};
