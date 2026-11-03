/**
 * A pointer-positioned menu (P3-02): opens at client coordinates, stays inside the window, takes
 * arrow keys / Home / End, and closes on Escape, an outside click, the wheel, a resize and window blur.
 * Rows come from Menu.tsx (MenuItemButton), so it looks and behaves like the click menu.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type MenuItem, MenuItemButton, MenuSeparator } from './Menu';

const EDGE = 8;

export function ContextMenu({
  x,
  y,
  items,
  onClose,
  label,
}: {
  x: number;
  y: number;
  items: Array<MenuItem | 'separator'>;
  onClose: () => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [place, setPlace] = useState({ left: x, top: y });

  // keep the menu inside the window
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    const width = box?.width ?? 0;
    const height = box?.height ?? 0;
    setPlace({
      left: Math.max(EDGE, Math.min(x, window.innerWidth - width - EDGE)),
      top: Math.max(EDGE, Math.min(y, window.innerHeight - height - EDGE)),
    });
  }, [x, y]);

  useEffect(() => {
    const close = () => onCloseRef.current();
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('wheel', close, { passive: true, capture: true });
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('wheel', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, []);

  const onListKey = (event: React.KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nodes = [
      ...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []),
    ];
    if (!nodes.length) return;
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    let next = 0;
    if (event.key === 'ArrowDown') next = (index + 1) % nodes.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + nodes.length) % nodes.length;
    else if (event.key === 'End') next = nodes.length - 1;
    nodes[next]?.focus();
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onListKey}
      onContextMenu={(event) => event.preventDefault()}
      style={{ left: place.left, top: place.top }}
      className="fixed z-50 min-w-56 rounded-xl border border-line bg-surface p-1 shadow-lift"
    >
      {items.map((item, i) =>
        item === 'separator' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity
          <MenuSeparator key={`sep-${i}`} />
        ) : (
          <MenuItemButton key={item.key} item={item} onDone={onClose} />
        ),
      )}
    </div>,
    document.body,
  );
}
