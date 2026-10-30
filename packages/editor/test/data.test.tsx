import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { demoNodeTypes } from '../src/demo/fixtures';
import { applyBrand, readableTextOn, safeImageUrl, sanitizeColor } from '../src/lib/brand';
import {
  accessPath,
  compareItems,
  diffJson,
  fieldExpression,
  flattenSchema,
  inferSchema,
  tableColumns,
} from '../src/lib/data';
import { Markdown } from '../src/lib/markdown';
import { buildCatalog, filterCatalog, nodeActions } from '../src/lib/node-catalog';
import { passwordProblem, safeRedirect } from '../src/pages/auth/AuthPages';
import { parseWorkflowImport } from '../src/pages/WorkflowsPage';

describe('schema and table helpers', () => {
  const items = [
    { json: { id: 1, customer: { email: 'a@x' }, tags: ['x'] } },
    { json: { id: 2, extra: null } },
  ];

  it('infers a union schema with nested fields', () => {
    const schema = inferSchema(items);
    expect(schema.map((f) => [f.key, f.kind])).toEqual([
      ['id', 'number'],
      ['customer', 'object'],
      ['tags', 'array'],
      ['extra', 'null'],
    ]);
    expect(flattenSchema(schema).map((f) => accessPath(f.path))).toEqual([
      '.id',
      '.customer',
      '.customer.email',
      '.tags',
      '.tags[0]',
      '.extra',
    ]);
    expect(tableColumns(items)).toEqual(['id', 'customer', 'tags', 'extra']);
  });

  it('builds expressions for dragged fields', () => {
    expect(fieldExpression(['customer', 'email'])).toBe('{{ $json.customer.email }}');
    expect(fieldExpression(['first name'])).toBe('{{ $json["first name"] }}');
    expect(fieldExpression(['id'], "Bob's node")).toBe("{{ $('Bob\\'s node').item.json.id }}");
  });

  it('diffs runs by item', () => {
    const result = compareItems([{ json: { a: 1, b: 2 } }], [{ json: { a: 1, b: 3, c: 4 } }, { json: {} }]);
    expect(result.identical).toBe(false);
    expect(result.entries).toEqual([
      { path: '[0].b', kind: 'changed', before: 2, after: 3 },
      { path: '[0].c', kind: 'added', after: 4 },
      { path: '[1]', kind: 'added', after: {} },
    ]);
    expect(diffJson({ a: [1] }, { a: [1] })).toEqual([]);
  });
});

describe('branding', () => {
  it('accepts only hex colours and safe image URLs', () => {
    expect(sanitizeColor('#ABC')).toBe('#aabbcc');
    expect(sanitizeColor('red;background:url(x)')).toBeNull();
    expect(safeImageUrl('javascript:alert(1)')).toBeNull();
    expect(safeImageUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(safeImageUrl('https://cdn.example.com/logo.png')).toBe('https://cdn.example.com/logo.png');
    expect(readableTextOn('#ffffff')).toBe('#111a22');
    expect(readableTextOn('#1a1a7a')).toBe('#ffffff');
  });

  it('applies the brand to CSS variables, title and favicon', () => {
    applyBrand({ name: 'Acme Flows', primaryColor: '#0f8a6c', logoUrl: null });
    expect(document.documentElement.style.getPropertyValue('--wf-brand')).toBe('#0f8a6c');
    expect(document.title).toBe('Acme Flows');
    expect(document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href).toMatch(
      /^data:image\/svg\+xml/,
    );
  });
});

describe('sticky note markdown', () => {
  it('renders formatting without HTML injection and drops unsafe links', () => {
    const { container } = render(
      <Markdown
        source={
          '# Title\n**bold** and `code`\n- one\n- two\n[ok](https://example.com) [bad](javascript:alert(1))\n<img src=x onerror=alert(1)>'
        }
      />,
    );
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    const links = [...container.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/']);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('node creator catalogue', () => {
  const catalog = buildCatalog(demoNodeTypes);

  it('lists triggers first when the workflow has none and hides hidden nodes', () => {
    const sections = filterCatalog(catalog, { query: '', noTriggerYet: true });
    expect(sections[0].title).toBe('Start with a trigger');
    expect(sections[0].entries.every((e) => e.isTrigger)).toBe(true);
    expect(sections.flatMap((s) => s.entries).some((e) => e.description.name === 'test.kitchenSink')).toBe(
      false,
    );
  });

  it('searches names, aliases and actions', () => {
    const names = (query: string) =>
      filterCatalog(catalog, { query }).flatMap((s) => s.entries.map((e) => e.description.name));
    expect(names('http')[0]).toBe('core.httpRequest');
    expect(names('javascript')).toEqual(['core.code']);
    expect(names('create a deal')).toEqual(['app.crm']);
  });

  it('filters by connection context', () => {
    const afterOutput = filterCatalog(catalog, { query: '', needsMainInput: true }).flatMap((s) => s.entries);
    expect(afterOutput.some((e) => e.isTrigger)).toBe(false);
    const models = filterCatalog(catalog, { query: '', outputType: 'ai_languageModel' }).flatMap(
      (s) => s.entries,
    );
    expect(models.map((e) => e.description.name)).toEqual(['ai.lmChatDemo']);
  });

  it('derives actions per resource', () => {
    const crm = demoNodeTypes.find((d) => d.name === 'app.crm')!;
    expect(nodeActions(crm)).toEqual([
      {
        label: 'Get a contact',
        description: undefined,
        parameters: { resource: 'contact', operation: 'get' },
      },
      {
        label: 'Create a contact',
        description: undefined,
        parameters: { resource: 'contact', operation: 'create' },
      },
      {
        label: 'Create a deal',
        description: undefined,
        parameters: { resource: 'deal', operation: 'create' },
      },
    ]);
  });
});

describe('auth and import helpers', () => {
  it('only redirects to relative in-app paths', () => {
    expect(safeRedirect('/workflow/1')).toBe('/workflow/1');
    expect(safeRedirect('//evil.example')).toBe('/workflows');
    expect(safeRedirect('https://evil.example')).toBe('/workflows');
    expect(safeRedirect('/\\evil')).toBe('/workflows');
    expect(safeRedirect(null)).toBe('/workflows');
  });

  it('checks password rules', () => {
    expect(passwordProblem('short1')).toMatch(/8 characters/);
    expect(passwordProblem('longenough')).toMatch(/digit/);
    expect(passwordProblem('longenough1')).toBeNull();
  });

  it('parses exported workflows for import', () => {
    const parsed = parseWorkflowImport(
      JSON.stringify({
        name: 'Exported',
        nodes: [{ name: 'A', type: 'core.noOp', parameters: {} }],
        connections: {},
        settings: { timezone: 'UTC' },
      }),
    );
    expect(parsed).toMatchObject({ name: 'Exported', settings: { timezone: 'UTC' } });
    expect(parseWorkflowImport('{"hello":1}')).toHaveProperty('error');
  });
});
