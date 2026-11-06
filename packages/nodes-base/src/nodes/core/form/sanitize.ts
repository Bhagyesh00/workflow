/**
 * What a form page may hold from a workflow. Defence in depth: the real boundary is the CSP sandbox
 * every form reply carries (routes/webhooks.ts), which gives the page an opaque origin.
 */
import sanitize from 'sanitize-html';

const SANITIZE_OPTIONS: sanitize.IOptions = {
  allowedTags: [
    'a',
    'b',
    'blockquote',
    'br',
    'caption',
    'code',
    'dd',
    'div',
    'dl',
    'dt',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'iframe',
    'img',
    'li',
    'ol',
    'p',
    'pre',
    's',
    'small',
    'source',
    'span',
    'strong',
    'sub',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
    'video',
  ],
  // no id or name: a field must not stand in for the elements the page script looks up
  allowedAttributes: {
    '*': ['class', 'dir', 'lang', 'title', 'role', 'aria-*'],
    a: ['href', 'target', 'rel'],
    iframe: ['src', 'width', 'height', 'title', 'allow', 'sandbox'],
    img: ['src', 'alt', 'width', 'height'],
    source: ['src', 'type'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    video: ['src', 'controls', 'width', 'height', 'poster'],
  },
  allowedSchemes: ['http', 'https'],
  allowedSchemesByTag: {},
  allowedSchemesAppliedToAttributes: ['href', 'src', 'poster'],
  allowProtocolRelative: false,
  // the library drops empty values of these; an empty sandbox is the strictest one, so it must stay
  nonBooleanAttributes: sanitize.defaults.nonBooleanAttributes.filter((name) => name !== 'sandbox'),
  transformTags: {
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: 'noopener noreferrer' } }),
    iframe: (tagName, attribs) => ({ tagName, attribs: { ...attribs, sandbox: '' } }),
  },
};

/** the form description and Custom HTML fields */
export function sanitizeHtml(html: string): string {
  return sanitize(html, SANITIZE_OPTIONS);
}

/** CSS goes inside a style element, where nothing but `<` can end it */
export function sanitizeCustomCss(css: string): string {
  return css.split('<').join('');
}

/** an http or https URL, or undefined; a bare host name counts as http, as n8n does */
export function safeRedirectUrl(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  try {
    const url = new URL(text.includes('://') ? text : `http://${text}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
