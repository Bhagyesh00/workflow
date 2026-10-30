import { useEffect } from 'react';
import { useSettings } from '../../api/queries';
import { applyBrand, brandInitial, safeImageUrl } from '../../lib/brand';
import { cx } from '../ui/cx';

/** Applies the white-label brand (colour variables, title, favicon) whenever settings change. */
export function BrandApplier() {
  const settings = useSettings();
  useEffect(() => {
    applyBrand(settings.brand);
  }, [settings.brand]);
  return null;
}

export function BrandMark({
  size = 32,
  withName = true,
  className,
}: {
  size?: number;
  withName?: boolean;
  className?: string;
}) {
  const { brand } = useSettings();
  const logo = safeImageUrl(brand.logoUrl);
  const name = brand.name?.trim() || 'Workflow';
  return (
    <span className={cx('flex min-w-0 items-center gap-2.5', className)}>
      {logo ? (
        <img src={logo} alt="" width={size} height={size} className="shrink-0 rounded-lg object-contain" />
      ) : (
        <span
          aria-hidden="true"
          className="grid shrink-0 place-items-center rounded-[10px] bg-brand font-display font-bold text-on-brand"
          style={{ width: size, height: size, fontSize: size * 0.5 }}
        >
          {brandInitial(name)}
        </span>
      )}
      {withName && <span className="truncate font-display text-md font-semibold text-ink">{name}</span>}
    </span>
  );
}
