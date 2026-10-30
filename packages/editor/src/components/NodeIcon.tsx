/**
 * Node icons from `description.icon`:
 *  - `lucide:<name>`  -> the lucide-react icon (the full icon set is a lazily loaded chunk)
 *  - `simple:<slug>`  -> a coloured letter avatar (no network fetch for brand logos)
 *  - `data:image/...` -> rendered as an <img>
 */
import type { NodeTypeDescription } from '@workflow/workflow';
import type { LucideIcon } from 'lucide-react';
import { Box } from 'lucide-react';
import { useSyncExternalStore } from 'react';

type IconMap = Record<string, LucideIcon>;

let iconMap: IconMap | null = null;
let loading: Promise<IconMap> | null = null;
const listeners = new Set<() => void>();

export function loadIconMap(): Promise<IconMap> {
  loading ??= import('lucide-react/icons/index').then((mod) => {
    iconMap = mod as unknown as IconMap;
    for (const listener of listeners) listener();
    return iconMap;
  });
  return loading;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!iconMap) void loadIconMap().catch(() => undefined);
  return () => listeners.delete(listener);
}

function useIconMap(): IconMap | null {
  return useSyncExternalStore(
    subscribe,
    () => iconMap,
    () => null,
  );
}

/** `mouse-pointer-click` -> `MousePointerClick` */
export function lucideComponentName(name: string): string {
  return name
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

const AVATAR_COLORS = [
  '#3d63dd',
  '#d1453b',
  '#0f8a6c',
  '#c27a00',
  '#7c4dcc',
  '#0e7f9e',
  '#c2387a',
  '#4a7b2c',
];

export function avatarColor(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

const SAFE_DATA_IMAGE = /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml)[;,]/i;

export function NodeIcon({
  description,
  size = 20,
  fallbackName,
}: {
  description: Pick<NodeTypeDescription, 'icon' | 'iconColor' | 'displayName' | 'name'> | undefined;
  size?: number;
  fallbackName?: string;
}) {
  const icons = useIconMap();
  const icon = description?.icon ?? '';

  if (icon.startsWith('lucide:')) {
    const Component = icons?.[lucideComponentName(icon.slice('lucide:'.length))];
    if (Component) return <Component size={size} strokeWidth={1.9} aria-hidden="true" />;
    if (!icons) return <span style={{ width: size, height: size }} aria-hidden="true" />;
  }
  if (icon.startsWith('data:') && SAFE_DATA_IMAGE.test(icon)) {
    return <img src={icon} width={size} height={size} alt="" className="object-contain" draggable={false} />;
  }
  if (icon.startsWith('simple:') || !icon) {
    const label = description?.displayName ?? fallbackName ?? '?';
    const slug = icon.startsWith('simple:') ? icon.slice('simple:'.length) : (description?.name ?? label);
    const color = description?.iconColor ?? avatarColor(slug);
    if (!description && !fallbackName) return <Box size={size} aria-hidden="true" />;
    return (
      <span
        aria-hidden="true"
        className="grid place-items-center rounded-md font-display font-bold text-white"
        style={{ width: size + 2, height: size + 2, background: color, fontSize: Math.round(size * 0.62) }}
      >
        {label.trim().charAt(0).toUpperCase() || '?'}
      </span>
    );
  }
  return <Box size={size} aria-hidden="true" />;
}
