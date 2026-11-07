import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('bash', bash);

const CLASS_TOKEN = /^[A-Za-z0-9_-]+$/;

/** highlight.js writes `hljs-*` classes and sometimes a trailing-underscore modifier such as `function_`. */
function safeClasses(value: string): string {
  return value
    .split(/\s+/)
    .filter((token) => CLASS_TOKEN.test(token) && (token.startsWith('hljs-') || token.endsWith('_')))
    .join(' ');
}

/** Copy only text nodes and `span` elements with highlight classes; any other element keeps its text only. */
function copyNodes(from: Node, into: Node): void {
  for (const node of Array.from(from.childNodes)) {
    if (node.nodeType === 3) {
      into.appendChild(document.createTextNode(node.nodeValue ?? ''));
    } else if (node.nodeType === 1) {
      const source = node as Element;
      const classes = source.localName === 'span' ? safeClasses(source.getAttribute('class') ?? '') : '';
      if (classes) {
        const span = document.createElement('span');
        span.className = classes;
        copyNodes(source, span);
        into.appendChild(span);
      } else {
        copyNodes(source, into);
      }
    }
  }
}

export function isHighlightLanguage(lang: string | undefined): boolean {
  return Boolean(lang && hljs.getLanguage(lang));
}

/**
 * Highlights `code` into `target`. The result of highlight.js is a string of spans, so it is parsed with
 * DOMParser (an inert document: no script runs, nothing loads) and rebuilt from allowed nodes only.
 * An unknown language, or a failure, writes the plain text.
 */
export function highlightInto(target: HTMLElement, code: string, lang: string | undefined): void {
  if (lang && hljs.getLanguage(lang)) {
    try {
      const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
      copyNodes(doc.body, target);
      return;
    } catch {
      while (target.firstChild) target.removeChild(target.firstChild);
    }
  }
  target.textContent = code;
}
