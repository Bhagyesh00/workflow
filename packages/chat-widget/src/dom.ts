/** Small DOM helpers. Everything is written with createElement and textContent: never an HTML string. */

export type Child = Node | string | null | undefined | false;

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  children?: Child[],
  attrs?: Record<string, string>,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (attrs) for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (children) append(node, children);
  return node;
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** A button with a text label (and optional title) that never submits a form. */
export function button(className: string, label: string, title?: string): HTMLButtonElement {
  const node = el('button', className, [label], { type: 'button' });
  if (title) {
    node.title = title;
    node.setAttribute('aria-label', title);
  }
  return node;
}

/** Tracks blob URLs made for image previews so they can be revoked. */
export interface BlobTracker {
  create(file: Blob): string | undefined;
  revoke(url: string): void;
  revokeAll(): void;
}

export function createBlobTracker(): BlobTracker {
  const urls = new Set<string>();
  return {
    create(file) {
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined;
      const url = URL.createObjectURL(file);
      urls.add(url);
      return url;
    },
    revoke(url) {
      if (urls.delete(url) && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    },
    revokeAll() {
      for (const url of urls) if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}
