/**
 * /settings/security: a shell over `SECURITY_SECTIONS` (components/security/sections.ts). Each section gates
 * itself; workflow reviews (P3-19) is components/security/WorkflowReviewsSection.tsx.
 */
import { useMe } from '../api/queries';
import { SECURITY_SECTIONS } from '../components/security/sections';
import { PageLoader } from '../components/ui/misc';

export function SecuritySettingsPage() {
  const me = useMe();
  if (me.isLoading) return <PageLoader />;
  return (
    <section className="flex max-w-2xl flex-col gap-4">
      <h2 className="text-lg font-semibold">Security</h2>
      {SECURITY_SECTIONS.map(({ id, Component }) => (
        <Component key={id} />
      ))}
    </section>
  );
}
