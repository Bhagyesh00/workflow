import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FROM_AI_MARKER, type NodeProperty, type NodeTypeDescription } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { demoNodeTypes } from '../src/demo/fixtures';
import {
  buildFromAiOverride,
  canUseFromAiOverride,
  fromAiKeyFromPath,
  fromAiTypeOf,
  parseFromAiOverride,
  reconcileFromAiKeys,
} from '../src/lib/from-ai-override';
import { signedIn } from './backend';
import { renderParameters } from './utils';

const httpTool = demoNodeTypes.find((d) => d.name === 'core.httpRequestTool')!;
const httpNode = demoNodeTypes.find((d) => d.name === 'core.httpRequest')!;
const prop = (type: NodeProperty['type'], extra: Partial<NodeProperty> = {}): NodeProperty => ({
  displayName: 'P',
  name: 'p',
  type,
  default: '',
  ...extra,
});
const tool = (name: string, overrides: Partial<NodeTypeDescription> = {}): NodeTypeDescription => ({
  ...httpTool,
  name,
  ...overrides,
});
const field = (name: string) => document.querySelector<HTMLElement>(`[data-parameter="${name}"]`)!;
const BUTTON = 'Let the model define this parameter';

describe('canUseFromAiOverride', () => {
  it('allows a plain parameter of a tool node', () => {
    expect(canUseFromAiOverride(httpTool, prop('string'), ['url'])).toBe(true);
    expect(canUseFromAiOverride(httpTool, prop('number'), ['limit'])).toBe(true);
    expect(canUseFromAiOverride(httpTool, prop('boolean'), ['flag'])).toBe(true);
    expect(canUseFromAiOverride(httpTool, prop('string'), ['headers', 'values', 0, 'name'])).toBe(true);
  });

  it('refuses a node that is not an AI tool', () => {
    expect(canUseFromAiOverride(httpNode, prop('string'), ['url'])).toBe(false);
    expect(canUseFromAiOverride(undefined, prop('string'), ['url'])).toBe(false);
    expect(canUseFromAiOverride(tool('x.tool', { categories: ['AI'] }), prop('string'), ['url'])).toBe(false);
    expect(canUseFromAiOverride(tool('x.tool', { outputs: ['main'] }), prop('string'), ['url'])).toBe(false);
  });

  it.each(['ai.toolCode', 'ai.toolHttpRequest', 'ai.mcpClientTool', 'ai.vectorStoreQdrant'])(
    'refuses %s',
    (name) => expect(canUseFromAiOverride(tool(name), prop('string'), ['url'])).toBe(false),
  );

  it.each([['toolName'], ['description'], ['toolDescription']])('refuses the path %s', (name) => {
    expect(canUseFromAiOverride(httpTool, prop('string'), [name])).toBe(false);
  });

  it('refuses the tool paths only at the top level', () => {
    expect(canUseFromAiOverride(httpTool, prop('string'), ['options', 'description'])).toBe(true);
  });

  it.each(['options', 'credentialsSelect', 'collection', 'fixedCollection', 'filter', 'code'] as const)(
    'refuses type %s',
    (type) => expect(canUseFromAiOverride(httpTool, prop(type), ['x'])).toBe(false),
  );

  it('refuses noDataExpression', () => {
    expect(canUseFromAiOverride(httpTool, prop('string', { noDataExpression: true }), ['x'])).toBe(false);
  });
});

describe('key and type', () => {
  it('builds the key from the path', () => {
    expect(fromAiKeyFromPath(['url'])).toBe('url');
    expect(fromAiKeyFromPath(['headers', 'values', 0, 'name'])).toBe('headers_values_0_name');
    expect(fromAiKeyFromPath(['a b.c', 'd-e'])).toBe('a_b_c_d-e');
    expect(fromAiKeyFromPath(['x'.repeat(100)])).toHaveLength(63);
  });

  it('maps the property type', () => {
    expect(fromAiTypeOf(prop('number'))).toBe('number');
    expect(fromAiTypeOf(prop('boolean'))).toBe('boolean');
    expect(fromAiTypeOf(prop('json'))).toBe('json');
    expect(fromAiTypeOf(prop('string'))).toBe('string');
    expect(fromAiTypeOf(prop('dateTime'))).toBe('string');
  });
});

describe('value round trip', () => {
  it('writes the marker and the call', () => {
    expect(buildFromAiOverride({ key: 'url', description: 'The page', type: 'string' })).toBe(
      `={{ ${FROM_AI_MARKER} $fromAI('url', 'The page', 'string') }}`,
    );
  });

  it.each([
    'plain',
    '',
    "it's",
    'say "hi"',
    'both \' and " here',
    'all \' " ` together',
    'back\\slash',
    'line\nbreak\r\n',
    'tick ` and ${x}',
    "}} ) $fromAI('x') end",
    'unicode é 日本',
  ])('reads back %j', (description) => {
    for (const type of ['string', 'number', 'boolean', 'json'] as const) {
      const text = buildFromAiOverride({ key: 'k-1', description, type });
      expect(parseFromAiOverride(text)).toEqual({ key: 'k-1', description, type });
    }
  });

  it('picks the quote with the fewest escapes', () => {
    expect(buildFromAiOverride({ key: 'k', description: "it's", type: 'string' })).toContain(`"it's"`);
    expect(buildFromAiOverride({ key: 'k', description: `it's "x"`, type: 'string' })).toContain(
      '`' + `it's "x"` + '`',
    );
  });

  it('reads a resource locator value', () => {
    const text = buildFromAiOverride({ key: 'k', description: 'd', type: 'string' });
    expect(parseFromAiOverride({ __rl: true, mode: 'id', value: text })).toEqual({
      key: 'k',
      description: 'd',
      type: 'string',
    });
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'plain text',
    "={{ $fromAI('k', 'd', 'string') }}",
    `={{ ${FROM_AI_MARKER} $json.a }}`,
    `={{ ${FROM_AI_MARKER} $fromAI('k', 'd', 'color') }}`,
    `={{ ${FROM_AI_MARKER} $fromAI('', 'd', 'string') }}`,
    `={{ ${FROM_AI_MARKER} $fromAI('k', 'd', 'string') }} more`,
    `={{ ${FROM_AI_MARKER} $fromAI('k', 'd', 'string') + $env.A }}`,
    `={{ ${FROM_AI_MARKER} $fromAI('k', 'd', 'string'`,
    `={{ ${FROM_AI_MARKER} $fromAI('k', \`\${x}\`, 'string') }}`,
    { __rl: true, value: 'x' },
  ])('returns null for %j', (value) => {
    expect(parseFromAiOverride(value)).toBeNull();
  });
});

describe('reconcileFromAiKeys', () => {
  const at = (key: string) => buildFromAiOverride({ key, description: 'd', type: 'string' });

  it('moves the key with the row', () => {
    const next = reconcileFromAiKeys({
      rows: [{ name: at('rows_1_name') }, { name: at('rows_2_name') }],
      url: at('url'),
    });
    expect(next).toEqual({
      rows: [{ name: at('rows_0_name') }, { name: at('rows_1_name') }],
      url: at('url'),
    });
  });

  it('keeps the same object when nothing moved, and leaves other values alone', () => {
    const same = { url: at('url'), n: 3, free: '={{ $json.a }}', nested: { list: [at('nested_list_0')] } };
    expect(reconcileFromAiKeys(same)).toBe(same);
  });

  it('follows a resource locator', () => {
    const next = reconcileFromAiKeys({ rows: [{ id: { __rl: true, mode: 'id', value: at('old') } }] });
    expect(next).toEqual({ rows: [{ id: { __rl: true, mode: 'id', value: at('rows_0_id') } }] });
  });
});

describe('FromAiOverride in the parameter form', () => {
  beforeEach(() => signedIn());

  it('shows the button on a tool node', () => {
    renderParameters(httpTool);
    expect(within(field('url')).getByRole('button', { name: BUTTON })).toBeTruthy();
  });

  it('has no button on a node that is not a tool', () => {
    renderParameters(httpNode);
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
  });

  it('has no button on the description and the options', () => {
    renderParameters(httpTool);
    expect(within(field('toolDescription')).queryByRole('button', { name: BUTTON })).toBeNull();
    expect(within(field('method')).queryByRole('button', { name: BUTTON })).toBeNull();
  });

  it('has no button when the node is read only', () => {
    renderParameters(httpTool, { readOnly: true });
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
  });

  it('writes the value, shows the panel, edits the description and gives the value back', async () => {
    const user = userEvent.setup();
    const { node } = renderParameters(httpTool, { parameters: { url: 'https://a.test' } });
    await user.click(within(field('url')).getByRole('button', { name: BUTTON }));
    expect(node.current.parameters.url).toBe(`={{ ${FROM_AI_MARKER} $fromAI('url', '', 'string') }}`);

    const panel = within(field('url')).getByRole('region', { name: 'Defined by agent' });
    expect(within(panel).getByText('Defined by agent')).toBeTruthy();
    expect(within(field('url')).queryByRole('button', { name: BUTTON })).toBeNull();

    await user.type(within(panel).getByRole('textbox', { name: 'Description' }), "It's the page");
    expect(parseFromAiOverride(node.current.parameters.url)).toEqual({
      key: 'url',
      description: "It's the page",
      type: 'string',
    });

    await user.click(within(panel).getByRole('button', { name: 'Edit value' }));
    expect(node.current.parameters.url).toBe(
      httpTool.properties.find((p) => p.name === 'url')?.default ?? '',
    );
    expect(within(field('url')).getByRole('button', { name: BUTTON })).toBeTruthy();
  });

  it('shows the panel for a saved value, read only without the edit control', () => {
    const value = buildFromAiOverride({ key: 'url', description: 'The page', type: 'string' });
    renderParameters(httpTool, { parameters: { url: value }, readOnly: true });
    const panel = within(field('url')).getByRole('region', { name: 'Defined by agent' });
    expect((within(panel).getByRole('textbox', { name: 'Description' }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(within(panel).queryByRole('button', { name: 'Edit value' })).toBeNull();
  });

  it('shows the ordinary expression input for an expression the user wrote', () => {
    renderParameters(httpTool, { parameters: { url: "={{ $fromAI('url') }}" } });
    expect(screen.queryByRole('region', { name: 'Defined by agent' })).toBeNull();
  });
});
