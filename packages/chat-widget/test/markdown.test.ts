import { describe, expect, it } from 'vitest';
import { highlightInto, isHighlightLanguage } from '../src/highlight';
import { renderMarkdown, safeHref } from '../src/markdown';

function render(source: string): HTMLElement {
  const root = document.createElement('div');
  renderMarkdown(root, source);
  return root;
}

describe('links', () => {
  it('keeps http, https and mailto, opens in a new tab with noopener noreferrer', () => {
    const root = render('[a](http://example.test/x) [b](https://example.test/y) [c](mailto:me@example.test)');
    const links = Array.from(root.querySelectorAll('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'http://example.test/x',
      'https://example.test/y',
      'mailto:me@example.test',
    ]);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('gives a javascript: link no href', () => {
    const root = render('[click](javascript:alert(1))');
    const a = root.querySelector('a');
    expect(a?.hasAttribute('href')).toBe(false);
    expect(a?.textContent).toBe('click');
  });

  it('drops data:, vbscript:, file: and relative hrefs', () => {
    for (const href of [
      'data:text/html,<b>x</b>',
      'vbscript:x',
      'file:///etc/passwd',
      '/relative/path',
      '//host.test/x',
    ]) {
      expect(safeHref(href)).toBeUndefined();
    }
    expect(safeHref('  https://ok.test/a b ')).toBe('https://ok.test/a%20b');
    expect(safeHref('JaVaScRiPt:alert(1)')).toBeUndefined();
  });

  it('turns a bare URL into a link', () => {
    const root = render('see https://example.test/page now');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.test/page');
  });
});

describe('images', () => {
  it('makes no img element and prints a link instead', () => {
    const root = render('![a cat](https://example.test/cat.png)');
    expect(root.querySelectorAll('img')).toHaveLength(0);
    const a = root.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.test/cat.png');
    expect(a?.textContent).toBe('a cat');
  });

  it('prints only the alt text when the image URL is not safe', () => {
    const root = render('![pic](javascript:alert(1))');
    expect(root.querySelectorAll('img, a')).toHaveLength(0);
    expect(root.textContent).toBe('pic');
  });

  it('makes no img for raw HTML either', () => {
    const root = render('<img src="http://example.test/p.png" onerror="alert(1)">');
    expect(root.querySelectorAll('img')).toHaveLength(0);
    expect(root.textContent).toContain('<img src=');
  });
});

describe('raw HTML', () => {
  it('shows a raw script block as text', () => {
    const root = render('<script>alert(1)</script>');
    expect(root.querySelectorAll('script')).toHaveLength(0);
    expect(root.textContent).toContain('<script>alert(1)</script>');
  });

  it('shows inline tags as text and keeps the rest of the line', () => {
    const root = render('before <b onclick="x()">bold</b> after');
    expect(root.querySelectorAll('b')).toHaveLength(0);
    expect(root.textContent).toBe('before <b onclick="x()">bold</b> after');
  });

  it('shows iframes, forms and style as text', () => {
    const root = render(
      '<iframe src="http://evil.test"></iframe>\n\n<style>body{display:none}</style>\n\n<form action="/x"><input></form>',
    );
    expect(root.querySelectorAll('iframe, style, form, input')).toHaveLength(0);
  });

  it('decodes entities in text but never builds elements from them', () => {
    const root = render('a &amp; b &lt;i&gt;not italic&lt;/i&gt;');
    expect(root.querySelectorAll('i')).toHaveLength(0);
    expect(root.textContent).toBe('a & b <i>not italic</i>');
  });
});

describe('markdown blocks', () => {
  it('renders emphasis, code spans, headings, lists and quotes', () => {
    const root = render(
      '# Title\n\nsome **bold** and *em* and `a < b`\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted',
    );
    expect(root.querySelector('h1')?.textContent).toBe('Title');
    expect(root.querySelector('strong')?.textContent).toBe('bold');
    expect(root.querySelector('em')?.textContent).toBe('em');
    expect(root.querySelector('code')?.textContent).toBe('a < b');
    expect(root.querySelectorAll('ul > li')).toHaveLength(2);
    expect(root.querySelectorAll('ol > li')).toHaveLength(2);
    expect(root.querySelector('blockquote')?.textContent).toContain('quoted');
  });

  it('renders a table with text cells', () => {
    const root = render('| a | b |\n| - | - |\n| 1 | <u>2</u> |');
    expect(root.querySelectorAll('th')).toHaveLength(2);
    expect(root.querySelectorAll('td')).toHaveLength(2);
    expect(root.querySelectorAll('u')).toHaveLength(0);
  });

  it('writes plain user text as text, never as markup', () => {
    const root = render('<b>x</b> & "quotes"');
    expect(root.textContent).toBe('<b>x</b> & "quotes"');
    expect(root.children).toHaveLength(1);
  });

  it('replaces earlier content', () => {
    const root = document.createElement('div');
    renderMarkdown(root, 'first');
    renderMarkdown(root, 'second');
    expect(root.textContent).toBe('second');
  });
});

describe('code blocks', () => {
  it('highlights a known language with hljs spans and keeps the text exactly', () => {
    const source = 'const x = 1;\nconsole.log("hi");';
    const root = render(`\`\`\`javascript\n${source}\n\`\`\``);
    const code = root.querySelector('pre > code') as HTMLElement;
    expect(code.textContent).toBe(source);
    const spans = Array.from(code.querySelectorAll('span'));
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) expect(span.className).toMatch(/hljs-/);
    expect(code.className).toBe('language-javascript');
  });

  it('highlights typescript, python, xml and bash', () => {
    for (const lang of ['typescript', 'python', 'xml', 'bash', 'js', 'ts', 'py', 'sh', 'html']) {
      expect(isHighlightLanguage(lang)).toBe(true);
    }
    expect(isHighlightLanguage('cobol')).toBe(false);
    expect(isHighlightLanguage(undefined)).toBe(false);
  });

  it('writes plain text for an unknown language and for no language', () => {
    const unknown = render('```cobol\nMOVE 1 TO X\n```');
    expect(unknown.querySelector('code')?.textContent).toBe('MOVE 1 TO X');
    expect(unknown.querySelectorAll('code span')).toHaveLength(0);
    const none = render('```\nplain <b>text</b>\n```');
    expect(none.querySelector('code')?.textContent).toBe('plain <b>text</b>');
    expect(none.querySelectorAll('code b')).toHaveLength(0);
  });

  it('keeps markup inside highlighted code as text', () => {
    const root = render('```xml\n<script>alert(1)</script><img src=x onerror=alert(1)>\n```');
    expect(root.querySelectorAll('script, img')).toHaveLength(0);
    expect(root.querySelector('code')?.textContent).toBe(
      '<script>alert(1)</script><img src=x onerror=alert(1)>',
    );
    for (const el of Array.from(root.querySelectorAll('code *'))) expect(el.localName).toBe('span');
  });

  it('copies only text nodes and span elements with hljs classes', () => {
    const target = document.createElement('code');
    highlightInto(target, 'def f(x):\n    return "a" + str(1)  # note', 'python');
    for (const el of Array.from(target.querySelectorAll('*'))) {
      expect(el.localName).toBe('span');
      expect(el.getAttributeNames()).toEqual(['class']);
      expect(el.className.split(/\s+/).every((c) => c.startsWith('hljs-') || c.endsWith('_'))).toBe(true);
    }
    expect(target.textContent).toBe('def f(x):\n    return "a" + str(1)  # note');
  });
});
