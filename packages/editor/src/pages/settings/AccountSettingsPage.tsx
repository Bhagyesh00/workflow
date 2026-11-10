/** Settings > Your account: profile (P6-19), two-step sign-in (P6-18) and appearance. */
import { useMe, useSettings } from '../../api/queries';
import { MfaSection } from '../../components/account/MfaSection';
import { ProfileSection } from '../../components/account/ProfileSection';
import { PageLoader } from '../../components/ui/misc';
import { Segmented } from '../../components/ui/Tabs';
import { useUiStore } from '../../stores/ui-store';
import { Panel } from './Panel';

export function AccountSettingsPage() {
  const me = useMe();
  const settings = useSettings();
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  if (!me.data) return <PageLoader />;
  const { user, tenant, role } = me.data;
  return (
    <div className="flex flex-col gap-5">
      <Panel title="Your account">
        <dl className="grid grid-cols-[140px_1fr] gap-y-3 px-5 py-4 text-sm">
          <dt className="text-ink-3">Name</dt>
          <dd className="font-semibold">{user.name}</dd>
          <dt className="text-ink-3">Email</dt>
          <dd>{user.email}</dd>
          <dt className="text-ink-3">Workspace</dt>
          <dd>{tenant.name}</dd>
          <dt className="text-ink-3">Role</dt>
          <dd className="capitalize">{role}</dd>
          <dt className="text-ink-3">Timezone</dt>
          <dd>{settings.timezone}</dd>
        </dl>
      </Panel>
      {/* P6-19 (L3): name, email and password changes */}
      <ProfileSection />
      {/* P6-18 (L2): two-step sign-in; opens the setup dialog on `?mfa=setup` */}
      <MfaSection />
      <Panel title="Appearance" description="Applies to this browser only.">
        <div className="px-5 py-4">
          <Segmented
            label="Theme"
            value={theme}
            onChange={setTheme}
            items={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'Match system' },
            ]}
          />
        </div>
      </Panel>
    </div>
  );
}
