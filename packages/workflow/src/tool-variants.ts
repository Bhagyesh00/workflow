/**
 * Any node as an agent tool. A node with `usableAsTool` gets a `<name>Tool` copy at load; a node with webhooks
 * and a `sendAndWait` operation gets a `<name>HitlTool` human review copy. A copy shares the node's `execute`,
 * credentials and webhooks. The checks read the description alone, so they also answer for one that came
 * through JSON.
 */
import type { NodeProperty, NodeTypeDescription, WorkflowNode } from './interfaces';
import type { NodeType } from './node-types';

const TOOL_SUFFIX = 'Tool';
const HITL_SUFFIX = 'HitlTool';
const SEND_AND_WAIT = 'sendAndWait';
const AI_TOOL_CATEGORIES = ['AI', 'Tools'];
const HITL_MESSAGE = '=The agent wants to run this tool: {{ $tool.name }}\n\nInput:\n{{ $tool.parameters }}';
const TOOL_NAME_LENGTH = 64;

/** true for a description `toToolVariant` made */
export function isToolVariant(description: NodeTypeDescription): boolean {
  return (
    description.name.endsWith(TOOL_SUFFIX) &&
    !description.name.endsWith(HITL_SUFFIX) &&
    Array.isArray(description.inputs) &&
    description.inputs.length === 0 &&
    isToolNode(description) &&
    description.properties.some((property) => property.name === 'toolDescription')
  );
}

/** true for a description `toHitlVariant` made */
export function isHitlVariant(description: NodeTypeDescription): boolean {
  const { inputs } = description;
  return (
    description.name.endsWith(HITL_SUFFIX) &&
    isToolNode(description) &&
    Array.isArray(inputs) &&
    inputs.some((input) => (typeof input === 'string' ? input : input.type) === 'ai_tool')
  );
}

/** the outputs hold `ai_tool`; the caller checks that the type has `execute` */
export function isToolNode(description: NodeTypeDescription): boolean {
  const { outputs } = description;
  if (!Array.isArray(outputs)) return false;
  return outputs.some((output) => (typeof output === 'string' ? output : output.type) === 'ai_tool');
}

function offersSendAndWait(property: NodeProperty): boolean {
  return (
    property.name === 'operation' &&
    (property.options ?? []).some((option) => 'value' in option && option.value === SEND_AND_WAIT)
  );
}

/** n8n's rule: webhooks plus a `sendAndWait` operation, and a name ending in `Tool` is never a source */
export function hasSendAndWaitOperation(description: NodeTypeDescription): boolean {
  if (description.name.endsWith(TOOL_SUFFIX) || !description.webhooks?.length) return false;
  return description.properties.some(offersSendAndWait);
}

function withReplacements(description: NodeTypeDescription): NodeTypeDescription {
  const { usableAsTool } = description;
  return typeof usableAsTool === 'object' ? { ...description, ...usableAsTool.replacements } : description;
}

/** the tools section a source already names, else Other Tools */
function toolCategories(categories: string[] | undefined): string[] {
  const at = categories?.indexOf('Tools') ?? -1;
  const section = at >= 0 ? (categories?.slice(at + 1) ?? []) : [];
  return [...AI_TOOL_CATEGORIES, ...(section.length ? section : ['Other Tools'])];
}

function toolProperties(description: NodeTypeDescription): NodeProperty[] {
  const { properties } = description;
  const hasChoice = properties.some(({ name }) => name === 'resource' || name === 'operation');
  const added: NodeProperty[] = [
    ...(hasChoice
      ? [
          {
            displayName: 'Tool Description',
            name: 'descriptionType',
            type: 'options',
            default: 'auto',
            noDataExpression: true,
            options: [
              {
                name: 'Set Automatically',
                value: 'auto',
                description: 'Describe the tool from the resource and operation',
              },
              { name: 'Set Manually', value: 'manual', description: 'Write the description yourself' },
            ],
          } satisfies NodeProperty,
        ]
      : []),
    {
      displayName: 'Description',
      name: 'toolDescription',
      type: 'string',
      required: true,
      default: description.description,
      typeOptions: { rows: 2 },
      description:
        'Explain to the LLM what this tool does, a good, specific description would allow LLMs to produce expected results much more often',
      ...(hasChoice ? { displayOptions: { show: { descriptionType: ['manual'] } } } : {}),
    },
  ];
  // after any notice at the top
  const firstField = properties.findIndex((property) => property.type !== 'notice');
  const at = firstField < 0 ? properties.length : firstField;
  return [...properties.slice(0, at), ...added, ...properties.slice(at)];
}

export function toToolVariant(node: NodeType): NodeType {
  const {
    usableAsTool: _usableAsTool,
    outputNames: _outputNames,
    ...source
  } = withReplacements(node.description);
  return {
    ...node,
    description: {
      ...source,
      name: `${node.description.name}${TOOL_SUFFIX}`,
      displayName: `${source.displayName} ${TOOL_SUFFIX}`,
      inputs: [],
      outputs: ['ai_tool'],
      categories: toolCategories(source.categories),
      properties: toolProperties(source),
    },
  };
}

/** false when the property only shows for a value other than the fixed one, or hides for the fixed one */
function shownWith(property: NodeProperty, fixed: Record<string, unknown>): boolean {
  return Object.entries(fixed).every(([name, value]) => {
    const show = property.displayOptions?.show?.[name];
    const hide = property.displayOptions?.hide?.[name];
    return (!show || show.includes(value)) && !hide?.includes(value);
  });
}

export function toHitlVariant(node: NodeType): NodeType {
  const { usableAsTool: _usableAsTool, outputNames: _outputNames, ...source } = node.description;
  const { properties } = source;
  const operation = properties.find(offersSendAndWait);
  const resourceProperty = properties.find(({ name }) => name === 'resource');
  const resource = operation?.displayOptions?.show?.resource?.[0] ?? resourceProperty?.default;
  const fixed: Record<string, unknown> = {
    ...(resourceProperty ? { resource } : {}),
    operation: SEND_AND_WAIT,
    responseType: 'approval',
  };
  const hidden: NodeProperty[] = [
    ...(resourceProperty
      ? [
          {
            displayName: 'Resource',
            name: 'resource',
            type: 'hidden',
            default: resource,
          } satisfies NodeProperty,
        ]
      : []),
    { displayName: 'Operation', name: 'operation', type: 'hidden', default: SEND_AND_WAIT },
    { displayName: 'Response Type', name: 'responseType', type: 'hidden', default: 'approval' },
  ];
  const kept = properties
    .filter((property) => !Object.hasOwn(fixed, property.name) && shownWith(property, fixed))
    .map((property) => (property.name === 'message' ? { ...property, default: HITL_MESSAGE } : property));
  return {
    ...node,
    description: {
      ...source,
      name: `${source.name}${HITL_SUFFIX}`,
      description: 'Request human approval for tools',
      subtitle: 'Send and wait',
      inputs: [{ type: 'ai_tool', displayName: 'Tool', required: true }],
      outputs: [
        { type: 'ai_tool', displayName: 'Human review', filter: { nodes: ['ai.agent', 'ai.agentTool'] } },
      ],
      categories: [...AI_TOOL_CATEGORIES, 'Human in the Loop'],
      properties: [...hidden, ...kept],
    },
  };
}

/** the given nodes plus their tool and human review variants; a name already taken keeps its node */
export function withToolVariants(nodes: NodeType[]): NodeType[] {
  const taken = new Set(nodes.map((node) => node.description.name));
  const result: NodeType[] = [];
  const addVariant = (variant: NodeType) => {
    if (taken.has(variant.description.name)) return;
    taken.add(variant.description.name);
    result.push(variant);
  };
  for (const node of nodes) {
    result.push(node);
    if (node.description.usableAsTool) addVariant(toToolVariant(node));
    if (hasSendAndWaitOperation(node.description)) addVariant(toHitlVariant(node));
  }
  return result;
}

/** the name the model sees for a tool node */
export function toolNameOf(nodeName: string): string {
  const name = nodeName
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .slice(0, TOOL_NAME_LENGTH)
    .replace(/[_-]+$/, '');
  return name || 'tool';
}

/** `<action> in <defaults.name>`, else `<operation> <resource> in <defaults.name>`, else the node description */
function automaticDescription(description: NodeTypeDescription, resolve: (name: string) => unknown): string {
  const resource = resolve('resource');
  const operation = resolve('operation');
  if (!resource && !operation) return description.description;
  const action = description.properties
    .filter(({ name, displayOptions }) => {
      const resources = displayOptions?.show?.resource;
      return name === 'operation' && (!resources || resources.includes(resource));
    })
    .flatMap((property) => property.options ?? [])
    .find((option) => 'value' in option && option.value === operation);
  const inNode = `in ${description.defaults.name}`;
  if (action && 'action' in action && action.action) return `${action.action} ${inNode}`;
  return [operation, resource, inNode].filter(Boolean).join(' ');
}

/** the description the model sees; `resolve` reads a resolved parameter of `node` */
export function toolDescriptionFor(
  _node: WorkflowNode,
  description: NodeTypeDescription,
  resolve: (name: string) => unknown,
): string {
  const hasType = description.properties.some(({ name }) => name === 'descriptionType');
  if (hasType && resolve('descriptionType') !== 'manual') return automaticDescription(description, resolve);
  const text = resolve('toolDescription');
  return typeof text === 'string' && text ? text : description.description;
}
