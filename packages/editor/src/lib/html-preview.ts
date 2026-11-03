/**
 * HTML previews (P3-14): the srcdoc for `<iframe sandbox="" srcdoc referrerpolicy="no-referrer">`.
 *
 * The sandbox (an opaque origin with no script, forms, popups or top navigation) is the boundary.
 * Two more layers sit inside it: a CSP meta that comes first in the srcdoc, so nothing can load
 * from the network (only inline styles and data: images), and a DOMParser strip of active
 * elements and attributes, so scripts, frames, plugins, forms, base and meta tags, event
 * handlers and link targets never reach the frame. DOMParser builds an inert document: nothing in
 * it runs or loads while it is cleaned.
 */

/** The policy of the preview frame. */
export const HTML_PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`;

/** elements removed with their content */
const ACTIVE_ELEMENTS = [
  'script',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'portal',
  'base',
  'meta',
  'link',
  'form',
  'animate',
  'set',
  // template content is a separate fragment, and a shadowrootmode template becomes live markup
  'template',
];

/** attributes that navigate, submit or ping (event handlers `on*` are removed too) */
const ACTIVE_ATTRIBUTES = new Set(['href', 'xlink:href', 'target', 'ping', 'action', 'formaction', 'srcdoc']);

/** The head and body markup of `html` with every active element and attribute removed. */
export function stripActiveHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const element of [...doc.querySelectorAll(ACTIVE_ELEMENTS.join(','))]) element.remove();
  for (const element of [...doc.querySelectorAll('*')]) {
    for (const { name } of [...element.attributes]) {
      const lower = name.toLowerCase();
      if (lower.startsWith('on') || ACTIVE_ATTRIBUTES.has(lower)) element.removeAttribute(name);
    }
  }
  // a frameset document has no body once the frameset is removed
  return (doc.head?.innerHTML ?? '') + (doc.body?.innerHTML ?? '');
}

/** The srcdoc of the preview frame: the CSP meta first, then the stripped document. */
export function buildHtmlPreview(html: string): string {
  return CSP_META + stripActiveHtml(html);
}
