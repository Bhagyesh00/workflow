import type { NodeTypeDescription } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { demoNodeTypes } from '../src/demo/fixtures';
import { buildCatalog, filterCatalog } from '../src/lib/node-catalog';

const catalog = buildCatalog(demoNodeTypes);
const names = (sections: ReturnType<typeof filterCatalog>) =>
  sections.map((s) => [s.title, s.entries.map((e) => e.description.name)] as const);
const flat = (sections: ReturnType<typeof filterCatalog>) =>
  sections.flatMap((s) => s.entries.map((e) => e.description.name));

describe('tool variants in the node picker', () => {
  it('hides the tool and human review variants from the main list', () => {
    const all = flat(filterCatalog(catalog, { query: '' }));
    expect(all).toContain('core.httpRequest');
    expect(all).toContain('ai.toolCalculator');
    expect(all).not.toContain('core.httpRequestTool');
    expect(all).not.toContain('app.slackHitlTool');
  });

  it('hides them from a search that is not for a tool slot', () => {
    const found = flat(filterCatalog(catalog, { query: 'http' }));
    expect(found).toContain('core.httpRequest');
    expect(found).not.toContain('core.httpRequestTool');
    expect(flat(filterCatalog(catalog, { query: '', needsMainInput: true }))).not.toContain(
      'core.httpRequestTool',
    );
  });

  it('puts them in Other Tools and Human in the Loop under the ai_tool picker', () => {
    const sections = names(filterCatalog(catalog, { query: '', outputType: 'ai_tool' }));
    expect(sections.find(([title]) => title === 'Other Tools')?.[1]).toEqual(['core.httpRequestTool']);
    expect(sections.find(([title]) => title === 'Human in the Loop')?.[1]).toEqual(['app.slackHitlTool']);
    const plain = sections
      .filter(([title]) => title !== 'Other Tools' && title !== 'Human in the Loop')
      .flatMap(([, list]) => list);
    expect(plain).toContain('ai.toolCalculator');
    expect(plain).not.toContain('core.httpRequestTool');
    expect(sections.map(([title]) => title).slice(-2)).toEqual(['Other Tools', 'Human in the Loop']);
  });

  it('finds a variant by name in the ai_tool picker, in one Results list', () => {
    const sections = names(filterCatalog(catalog, { query: 'slack', outputType: 'ai_tool' }));
    expect(sections).toEqual([['Results', ['app.slackHitlTool']]]);
  });

  it('keeps a node with a Tool name but no tool-variant shape in the main list', () => {
    const lookalike: NodeTypeDescription = {
      ...demoNodeTypes.find((d) => d.name === 'ai.toolCalculator')!,
      name: 'test.fooTool',
      displayName: 'Foo Tool',
    };
    expect(flat(filterCatalog(buildCatalog([lookalike]), { query: '' }))).toEqual(['test.fooTool']);
  });

  it('builds the catalogue with every variant, hidden only by the filter', () => {
    const all = catalog.map((e) => e.description.name);
    expect(all).toContain('core.httpRequestTool');
    expect(all).toContain('app.slackHitlTool');
  });
});
