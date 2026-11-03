/**
 * HTML previews (P3-14): the srcdoc for `<iframe sandbox="" srcdoc referrerpolicy="no-referrer">`.
 *
 * The sandbox (an opaque origin with no script, forms, popups or top navigation) is the boundary.
 * Two more layers sit inside it: a CSP meta that comes first in the srcdoc, so nothing can load
 * from the network (only inline styles and data: images), and a DOMParser strip of active
 * elements and attributes, so scripts, frames, plugins, forms, base and meta tags, event
 * handlers and link targets never reach the frame. DOMParser builds an inert document: nothing in
 * it runs or loads while it is cleaned. The strip runs again on its own output until a parse finds
 * nothing to remove (at most three rounds, else the file is shown as text).
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

/** strip and serialize rounds before a file that keeps changing is shown as text */
const MAX_STRIP_ROUNDS = 3;

/** One parse and strip: the head and body markup, and whether anything was removed. */
function stripOnce(html: string): { markup: string; removed: boolean } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let removed = false;
  for (const element of [...doc.querySelectorAll(ACTIVE_ELEMENTS.join(','))]) {
    element.remove();
    removed = true;
  }
  for (const element of [...doc.querySelectorAll('*')]) {
    for (const { name } of [...element.attributes]) {
      const lower = name.toLowerCase();
      if (lower.startsWith('on') || ACTIVE_ATTRIBUTES.has(lower)) {
        element.removeAttribute(name);
        removed = true;
      }
    }
  }
  // a frameset document has no body once the frameset is removed
  return { markup: (doc.head?.innerHTML ?? '') + (doc.body?.innerHTML ?? ''), removed };
}

/**
 * The head and body markup of `html` with every active element and attribute removed, or null
 * when no clean markup is reached within three rounds. The frame parses the serialized markup
 * again, and a second parse can build a different tree (mutation XSS through math, svg and style),
 * so each serialized result is parsed and stripped again until a parse finds nothing to remove.
 */
export function stripActiveHtml(html: string): string | null {
  let current = html;
  for (let round = 0; round < MAX_STRIP_ROUNDS; round++) {
    const { markup, removed } = stripOnce(current);
    // the input itself is never the srcdoc, so round 0 always serializes
    if (round > 0 && !removed) return current;
    current = markup;
  }
  return null;
}

/** The srcdoc of the preview frame (the CSP meta first, then the stripped document), or null. */
export function buildHtmlPreview(html: string): string | null {
  const stripped = stripActiveHtml(html);
  return stripped === null ? null : CSP_META + stripped;
}
