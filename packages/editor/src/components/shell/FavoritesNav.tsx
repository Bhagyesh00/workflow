/**
 * The signed-in user's favorite workflows and folders in the left nav (P3-07, as n8n).
 * Hidden when the sidebar is collapsed or nothing is starred.
 */
import { Folder, Star, Workflow } from 'lucide-react';
import { NavLink } from 'react-router';
import { useFavorites } from '../../api/queries';
import { cx } from '../ui/cx';

export function FavoritesNav({ collapsed }: { collapsed: boolean }) {
  const { data } = useFavorites();
  if (collapsed || !data?.length) return null;
  return (
    <nav aria-label="Favorites" className="mt-3 flex flex-col gap-0.5">
      <h2 className="flex items-center gap-1.5 px-2.5 pb-1 text-2xs font-semibold tracking-wide text-ink-3 uppercase">
        <Star size={11} aria-hidden="true" /> Favorites
      </h2>
      <ul className="flex flex-col gap-0.5">
        {data.map((fav) => {
          const to =
            fav.resourceType === 'workflow'
              ? `/workflow/${encodeURIComponent(fav.resourceId)}`
              : `/workflows?folder=${encodeURIComponent(fav.resourceId)}`;
          const Icon = fav.resourceType === 'workflow' ? Workflow : Folder;
          return (
            <li key={`${fav.resourceType}:${fav.resourceId}`}>
              <NavLink
                to={to}
                end
                className={({ isActive }) =>
                  cx(
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
                    isActive && fav.resourceType === 'workflow'
                      ? 'bg-brand-soft text-brand'
                      : 'text-ink-2 hover:bg-surface-3 hover:text-ink',
                  )
                }
              >
                <Icon size={15} aria-hidden="true" className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{fav.name}</span>
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
