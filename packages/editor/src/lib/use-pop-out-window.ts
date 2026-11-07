/**
 * Moves a panel into its own browser window (P5-60): opens the window, copies the page's style
 * sheets and theme into it and hands back a container to portal into. The panel comes back when the
 * window is closed, by the person or by `close()`. A blocked pop-up shows a toast and leaves the
 * panel where it is.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '../stores/ui-store';

export interface PopOutWindow {
  /** the element in the new window to portal into; null while the panel is in the page */
  container: HTMLElement | null;
  isOpen: boolean;
  /** true when the window is open (also when it already was) */
  open: () => boolean;
  close: () => void;
}

const POPUP_FEATURES = 'popup=yes,width=980,height=640';

function copyStyles(from: Document, to: Document): void {
  for (const node of Array.from(from.head.querySelectorAll('link[rel="stylesheet"], style'))) {
    const copy = to.importNode(node, true) as HTMLElement;
    // a style element filled through the CSS object model has no text to clone
    if (node instanceof HTMLStyleElement && !node.textContent?.trim() && node.sheet) {
      try {
        copy.textContent = Array.from(node.sheet.cssRules)
          .map((rule) => rule.cssText)
          .join('\n');
      } catch {
        // a sheet the page cannot read stays empty
      }
    }
    to.head.appendChild(copy);
  }
  for (const attribute of ['class', 'data-theme', 'lang']) {
    const value = from.documentElement.getAttribute(attribute);
    if (value !== null) to.documentElement.setAttribute(attribute, value);
  }
  to.body.className = from.body.className;
  to.body.style.margin = '0';
}

export function usePopOutWindow(title = 'Logs'): PopOutWindow {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const windowRef = useRef<Window | null>(null);
  const watchRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const release = useCallback(() => {
    if (watchRef.current) clearInterval(watchRef.current);
    watchRef.current = null;
    windowRef.current = null;
    setContainer(null);
  }, []);

  const close = useCallback(() => {
    const popup = windowRef.current;
    release();
    try {
      popup?.close();
    } catch {
      // already gone
    }
  }, [release]);

  const open = useCallback(() => {
    const existing = windowRef.current;
    if (existing && !existing.closed) {
      existing.focus?.();
      return true;
    }
    let popup: Window | null = null;
    try {
      popup = window.open('', '', POPUP_FEATURES);
    } catch {
      popup = null;
    }
    if (!popup) {
      toast.error(
        'Couldn’t open the logs window',
        'Your browser blocked the pop-up. Allow pop-ups for this site and try again.',
      );
      return false;
    }
    popup.document.title = title;
    copyStyles(document, popup.document);
    const host = popup.document.createElement('div');
    host.setAttribute('data-pop-out-root', '');
    popup.document.body.appendChild(host);
    windowRef.current = popup;
    popup.addEventListener('pagehide', release);
    watchRef.current = setInterval(() => {
      if (windowRef.current?.closed) release();
    }, 500);
    setContainer(host);
    return true;
  }, [release, title]);

  // the window goes with the page it was opened from
  useEffect(
    () => () => {
      if (watchRef.current) clearInterval(watchRef.current);
      try {
        windowRef.current?.close();
      } catch {
        // already gone
      }
    },
    [],
  );

  return { container, isOpen: container !== null, open, close };
}
