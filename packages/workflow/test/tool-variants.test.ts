import { describe, expect, it } from 'vitest';
import type { NodeProperty, NodeTypeDescription, WorkflowNode } from '../src/interfaces';
import type { NodeType } from '../src/node-types';
import {
  hasSendAndWaitOperation,
  isHitlVariant,
  isToolNode,
  isToolVariant,
  toHitlVariant,
  toolDescriptionFor,
  toolNameOf,
  toToolVariant,
  withToolVariants,
} from '../src/tool-variants';

const execute: NonNullable<NodeType['execute']> = async () => [[]];

function description(overrides: Partial<NodeTypeDescription> = {}): NodeTypeDescription {
  return {
    name: 'app.thing',
    displayName: 'Thing',
    description: 'Works on things',
    group: ['output'],
    version: 1,
    defaults: { name: 'Thing' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [{ displayName: 'Value', name: 'value', type: 'string', default: '' }],
    usableAsTool: true,
    ...overrides,
  };
}

const typeOf = (overrides: Partial<NodeTypeDescription> = {}): NodeType => ({
  description: description(overrides),
  execute,
});

const webhooks: NodeTypeDescription['webhooks'] = [
  { name: 'default', httpMethod: 'GET', path: 'answer', isFullPath: false, restartWebhook: true },
];

const operationProperty = (values: string[], show?: Record<string, string[]>): NodeProperty => ({
  displayName: 'Operation',
  name: 'operation',
  type: 'options',
  default: values[0],
  options: values.map((value) => ({ name: value, value, action: `${value} a thing` })),
  ...(show ? { displayOptions: { show } } : {}),
});

function sendAndWaitType(overrides: Partial<NodeTypeDescription> = {}): NodeType {
  return typeOf({
    webhooks,
    credentials: [{ name: 'thingApi', required: true }],
    alias: ['stuff'],
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        default: 'channel',
        options: [
          { name: 'Channel', value: 'channel' },
          { name: 'Message', value: 'message' },
        ],
      },
      operationProperty(['archive'], { resource: ['channel'] }),
      operationProperty(['send', 'sendAndWait'], { resource: ['message'] }),
      {
        displayName: 'Channel',
        name: 'channel',
        type: 'string',
        default: '',
        displayOptions: { show: { resource: ['message'], operation: ['send', 'sendAndWait'] } },
      },
      {
        displayName: 'Text',
        name: 'text',
        type: 'string',
        default: '',
        displayOptions: { show: { resource: ['message'], operation: ['send'] } },
      },
      {
        displayName: 'Name',
        name: 'name',
        type: 'string',
        default: '',
        displayOptions: { show: { resource: ['channel'] } },
      },
      {
        displayName: 'Message',
        name: 'message',
        type: 'string',
        default: '',
        required: true,
        displayOptions: { show: { resource: ['message'], operation: ['sendAndWait'] } },
      },
      {
        displayName: 'Response Type',
        name: 'responseType',
        type: 'options',
        default: 'approval',
        options: [
          { name: 'Approval', value: 'approval' },
          { name: 'Free Text', value: 'freeText' },
        ],
        displayOptions: { show: { resource: ['message'], operation: ['sendAndWait'] } },
      },
      {
        displayName: 'Approval Options',
        name: 'approvalOptions',
        type: 'string',
        default: '',
        displayOptions: { show: { operation: ['sendAndWait'], responseType: ['approval'] } },
      },
      {
        displayName: 'Form',
        name: 'form',
        type: 'string',
        default: '',
        displayOptions: { show: { operation: ['sendAndWait'], responseType: ['freeText'] } },
      },
      {
        displayName: 'Hidden For Waits',
        name: 'hiddenForWaits',
        type: 'string',
        default: '',
        displayOptions: { hide: { operation: ['sendAndWait'] } },
      },
    ],
    ...overrides,
  });
}

const names = (properties: NodeProperty[]) => properties.map((p) => p.name);

describe('toToolVariant', () => {
  it('is the node as a sub-node with no main ports', () => {
    const source = typeOf();
    const variant = toToolVariant(source);
    const d = variant.description;
    expect(d.name).toBe('app.thingTool');
    expect(d.displayName).toBe('Thing Tool');
    expect(d.inputs).toEqual([]);
    expect(d.outputs).toEqual(['ai_tool']);
    expect(d.usableAsTool).toBeUndefined();
    expect(d.defaults).toEqual({ name: 'Thing' });
    expect(variant.execute).toBe(source.execute);
    expect(isToolNode(d)).toBe(true);
    expect(isToolVariant(d)).toBe(true);
  });

  it('keeps credentials, webhooks, aliases and the type methods, and leaves the source as it was', () => {
    const methods = { loadOptions: {} };
    const source = {
      ...sendAndWaitType(),
      methods,
    } as NodeType;
    const before = structuredClone(source.description);
    const { description: d, ...rest } = toToolVariant(source);
    expect(d.credentials).toEqual(source.description.credentials);
    expect(d.webhooks).toEqual(webhooks);
    expect(d.alias).toEqual(['stuff']);
    expect(rest.methods).toBe(methods);
    expect(source.description).toEqual(before);
  });

  it('with no resource or operation asks for a description only, first in the list', () => {
    const { properties } = toToolVariant(typeOf()).description;
    expect(names(properties)).toEqual(['toolDescription', 'value']);
    expect(properties[0]).toMatchObject({
      displayName: 'Description',
      type: 'string',
      required: true,
      default: 'Works on things',
      description:
        'Explain to the LLM what this tool does, a good, specific description would allow LLMs to produce expected results much more often',
    });
    expect(properties[0].displayOptions).toBeUndefined();
  });

  it('with a resource or an operation adds Tool Description and shows the text on manual only', () => {
    for (const property of [
      operationProperty(['a']),
      { displayName: 'Resource', name: 'resource', type: 'string', default: 'x' } as NodeProperty,
    ]) {
      const { properties } = toToolVariant(typeOf({ properties: [property] })).description;
      expect(names(properties)).toEqual(['descriptionType', 'toolDescription', property.name]);
      expect(properties[0]).toMatchObject({
        displayName: 'Tool Description',
        type: 'options',
        default: 'auto',
        options: [
          { name: 'Set Automatically', value: 'auto' },
          { name: 'Set Manually', value: 'manual' },
        ],
      });
      expect(properties[1].displayOptions).toEqual({ show: { descriptionType: ['manual'] } });
    }
  });

  it('goes after a leading notice', () => {
    const { properties } = toToolVariant(
      typeOf({
        properties: [
          { displayName: 'Careful', name: 'careful', type: 'notice', default: '' },
          { displayName: 'Value', name: 'value', type: 'string', default: '' },
        ],
      }),
    ).description;
    expect(names(properties)).toEqual(['careful', 'toolDescription', 'value']);
  });

  it('is in AI, Tools, and keeps a tools section or takes Other Tools', () => {
    expect(toToolVariant(typeOf({ categories: ['Core'] })).description.categories).toEqual([
      'AI',
      'Tools',
      'Other Tools',
    ]);
    expect(toToolVariant(typeOf()).description.categories).toEqual(['AI', 'Tools', 'Other Tools']);
    expect(
      toToolVariant(typeOf({ categories: ['AI', 'Tools', 'Recommended Tools'] })).description.categories,
    ).toEqual(['AI', 'Tools', 'Recommended Tools']);
  });

  it('applies replacements, which cannot change what makes it a tool', () => {
    const { description: d } = toToolVariant(
      typeOf({
        usableAsTool: {
          replacements: {
            description: 'Better words',
            categories: ['AI', 'Tools', 'Recommended Tools'],
            name: 'app.other',
            inputs: ['main'],
            outputs: ['main'],
          },
        },
      }),
    );
    expect(d.description).toBe('Better words');
    expect(d.properties[0]).toMatchObject({ name: 'toolDescription', default: 'Better words' });
    expect(d.categories).toEqual(['AI', 'Tools', 'Recommended Tools']);
    expect(d.name).toBe('app.thingTool');
    expect(d.inputs).toEqual([]);
    expect(d.outputs).toEqual(['ai_tool']);
    expect(d.usableAsTool).toBeUndefined();
  });

  it('drops output names of the main ports', () => {
    expect(toToolVariant(typeOf({ outputNames: ['a', 'b'] })).description.outputNames).toBeUndefined();
  });
});

describe('isToolVariant', () => {
  it('survives JSON, as the editor reads it from the server', () => {
    expect(isToolVariant(JSON.parse(JSON.stringify(toToolVariant(typeOf()).description)))).toBe(true);
  });

  it('is false for the source, a Human review copy and a hand-made tool node', () => {
    expect(isToolVariant(description())).toBe(false);
    expect(isToolVariant(toHitlVariant(sendAndWaitType()).description)).toBe(false);
    expect(
      isToolVariant(
        description({ name: 'ai.toolCalculator', inputs: [], outputs: ['ai_tool'], usableAsTool: undefined }),
      ),
    ).toBe(false);
  });
});

describe('hasSendAndWaitOperation', () => {
  const withOperation = (overrides: Partial<NodeTypeDescription> = {}) =>
    description({ webhooks, properties: [operationProperty(['send', 'sendAndWait'])], ...overrides });

  it('needs webhooks and a sendAndWait option', () => {
    expect(hasSendAndWaitOperation(withOperation())).toBe(true);
    expect(hasSendAndWaitOperation(withOperation({ webhooks: undefined }))).toBe(false);
    expect(hasSendAndWaitOperation(withOperation({ webhooks: [] }))).toBe(false);
    expect(hasSendAndWaitOperation(withOperation({ properties: [operationProperty(['send'])] }))).toBe(false);
  });

  it('finds it on any operation property', () => {
    expect(hasSendAndWaitOperation(sendAndWaitType().description)).toBe(true);
  });

  it('reads the operation property only', () => {
    const property: NodeProperty = {
      displayName: 'Mode',
      name: 'mode',
      type: 'options',
      default: 'sendAndWait',
      options: [{ name: 'Wait', value: 'sendAndWait' }],
    };
    expect(hasSendAndWaitOperation(withOperation({ properties: [property] }))).toBe(false);
  });

  it('skips names ending in Tool', () => {
    expect(hasSendAndWaitOperation(withOperation({ name: 'app.thingTool' }))).toBe(false);
    expect(hasSendAndWaitOperation(withOperation({ name: 'app.thingHitlTool' }))).toBe(false);
  });

  it('does not need the tool flag', () => {
    expect(hasSendAndWaitOperation(withOperation({ usableAsTool: undefined }))).toBe(true);
  });
});

describe('toHitlVariant', () => {
  const variant = toHitlVariant(sendAndWaitType());
  const d = variant.description;

  it('has the Human review face', () => {
    expect(d.name).toBe('app.thingHitlTool');
    expect(d.displayName).toBe('Thing');
    expect(d.subtitle).toBe('Send and wait');
    expect(d.description).toBe('Request human approval for tools');
    expect(d.usableAsTool).toBeUndefined();
    expect(d.categories).toEqual(['AI', 'Tools', 'Human in the Loop']);
    expect(isHitlVariant(d)).toBe(true);
    expect(isToolNode(d)).toBe(true);
  });

  it('takes a tool in and gives Human review out, to an agent only', () => {
    expect(d.inputs).toEqual([{ type: 'ai_tool', displayName: 'Tool', required: true }]);
    expect(d.outputs).toEqual([
      { type: 'ai_tool', displayName: 'Human review', filter: { nodes: ['ai.agent', 'ai.agentTool'] } },
    ]);
  });

  it('keeps credentials, webhooks and execute', () => {
    expect(d.credentials).toEqual([{ name: 'thingApi', required: true }]);
    expect(d.webhooks).toEqual(webhooks);
    expect(variant.execute).toBe(execute);
  });

  it('fixes resource, operation and response type, with the resource that has the operation', () => {
    const hidden = d.properties.filter((p) => p.type === 'hidden');
    expect(hidden.map((p) => [p.name, p.default])).toEqual([
      ['resource', 'message'],
      ['operation', 'sendAndWait'],
      ['responseType', 'approval'],
    ]);
    expect(names(d.properties).filter((n) => n === 'operation')).toHaveLength(1);
    expect(names(d.properties).filter((n) => n === 'responseType')).toHaveLength(1);
  });

  it('keeps only the parameters a send and wait with approval shows', () => {
    expect(names(d.properties)).toEqual([
      'resource',
      'operation',
      'responseType',
      'channel',
      'message',
      'approvalOptions',
    ]);
  });

  it('asks about the tool by default', () => {
    expect(d.properties.find((p) => p.name === 'message')?.default).toBe(
      '=The agent wants to run this tool: {{ $tool.name }}\n\nInput:\n{{ $tool.parameters }}',
    );
  });

  it('adds no resource to a node that has none', () => {
    const noResource = toHitlVariant(
      typeOf({
        webhooks,
        properties: [
          operationProperty(['send', 'sendAndWait']),
          { displayName: 'Message', name: 'message', type: 'string', default: '' },
        ],
      }),
    ).description;
    expect(names(noResource.properties)).toEqual(['operation', 'responseType', 'message']);
  });

  it('isHitlVariant survives JSON and refuses other nodes', () => {
    expect(isHitlVariant(JSON.parse(JSON.stringify(d)))).toBe(true);
    expect(isHitlVariant(description())).toBe(false);
    expect(isHitlVariant(toToolVariant(typeOf()).description)).toBe(false);
    expect(isHitlVariant(description({ name: 'x.oddHitlTool' }))).toBe(false);
  });
});

describe('withToolVariants', () => {
  const by = (nodes: NodeType[]) => nodes.map((n) => n.description.name);

  it('adds a tool copy for usableAsTool only', () => {
    const flagged = typeOf({ name: 'app.flagged' });
    const plain = typeOf({ name: 'app.plain', usableAsTool: undefined });
    const off = typeOf({ name: 'app.off', usableAsTool: false });
    expect(by(withToolVariants([flagged, plain, off]))).toEqual([
      'app.flagged',
      'app.flaggedTool',
      'app.plain',
      'app.off',
    ]);
  });

  it('adds a Human review copy by the rule, not by a list', () => {
    const anyName = sendAndWaitType({ name: 'vendor.never-heard-of', usableAsTool: undefined });
    expect(by(withToolVariants([anyName]))).toEqual([
      'vendor.never-heard-of',
      'vendor.never-heard-ofHitlTool',
    ]);
  });

  it('a node with both flags gets both copies', () => {
    expect(by(withToolVariants([sendAndWaitType()]))).toEqual([
      'app.thing',
      'app.thingTool',
      'app.thingHitlTool',
    ]);
  });

  it('never makes a copy of a copy', () => {
    const once = withToolVariants([sendAndWaitType()]);
    expect(by(withToolVariants(once))).toEqual(by(once));
  });

  it('a name ending in Tool gets no Human review copy', () => {
    const named = sendAndWaitType({ name: 'app.someTool', usableAsTool: undefined });
    expect(by(withToolVariants([named]))).toEqual(['app.someTool']);
  });

  it('a node that already has the name keeps it', () => {
    const own = typeOf({ name: 'app.thingTool', usableAsTool: undefined, displayName: 'Mine' });
    const result = withToolVariants([typeOf(), own]);
    expect(by(result)).toEqual(['app.thing', 'app.thingTool']);
    expect(result[1]).toBe(own);
  });

  it('leaves the given nodes as they are', () => {
    const source = typeOf();
    expect(withToolVariants([source])[0]).toBe(source);
    expect(source.description.usableAsTool).toBe(true);
  });
});

describe('toolNameOf', () => {
  it('turns runs of other characters into one underscore', () => {
    expect(toolNameOf('Get the  Weather!')).toBe('Get_the_Weather');
    expect(toolNameOf('a-b_c9')).toBe('a-b_c9');
  });

  it('cuts to 64 and removes trailing underscores and hyphens', () => {
    expect(toolNameOf('x'.repeat(70))).toHaveLength(64);
    expect(toolNameOf(`${'x'.repeat(63)}  y`)).toBe('x'.repeat(63));
    expect(toolNameOf('name -_')).toBe('name');
  });

  it('always leaves a name a model can call', () => {
    expect(toolNameOf('日本語')).toBe('tool');
  });
});

describe('toolDescriptionFor', () => {
  const node = { name: 'Node' } as WorkflowNode;
  const resolver = (values: Record<string, unknown>) => (name: string) => values[name];
  const withOperation = toToolVariant(sendAndWaitType()).description;

  it('auto gives the action of the operation in the node name', () => {
    expect(
      toolDescriptionFor(
        node,
        withOperation,
        resolver({ descriptionType: 'auto', resource: 'message', operation: 'send' }),
      ),
    ).toBe('send a thing in Thing');
  });

  it('auto reads the operation property of the chosen resource', () => {
    expect(
      toolDescriptionFor(
        node,
        withOperation,
        resolver({ descriptionType: 'auto', resource: 'channel', operation: 'archive' }),
      ),
    ).toBe('archive a thing in Thing');
  });

  it('auto without an action gives operation and resource', () => {
    const bare = toToolVariant(
      typeOf({
        properties: [
          { displayName: 'Resource', name: 'resource', type: 'string', default: '' },
          {
            displayName: 'Operation',
            name: 'operation',
            type: 'options',
            default: 'get',
            options: [{ name: 'Get', value: 'get' }],
          },
        ],
      }),
    ).description;
    expect(
      toolDescriptionFor(
        node,
        bare,
        resolver({ descriptionType: 'auto', resource: 'row', operation: 'get' }),
      ),
    ).toBe('get row in Thing');
    expect(toolDescriptionFor(node, bare, resolver({ descriptionType: 'auto', operation: 'get' }))).toBe(
      'get in Thing',
    );
  });

  it('auto with nothing to read gives the node description', () => {
    expect(toolDescriptionFor(node, withOperation, resolver({ descriptionType: 'auto' }))).toBe(
      'Works on things',
    );
  });

  it('manual gives the text, resolved', () => {
    expect(
      toolDescriptionFor(
        node,
        withOperation,
        resolver({ descriptionType: 'manual', toolDescription: 'Mine', operation: 'send' }),
      ),
    ).toBe('Mine');
  });

  it('with no type to choose gives the text, then the node description', () => {
    const plain = toToolVariant(typeOf()).description;
    expect(toolDescriptionFor(node, plain, resolver({ toolDescription: 'Mine' }))).toBe('Mine');
    expect(toolDescriptionFor(node, plain, resolver({ toolDescription: '' }))).toBe('Works on things');
    expect(toolDescriptionFor(node, plain, resolver({}))).toBe('Works on things');
  });

  it('a manual text left empty gives the node description', () => {
    expect(toolDescriptionFor(node, withOperation, resolver({ descriptionType: 'manual' }))).toBe(
      'Works on things',
    );
  });
});
