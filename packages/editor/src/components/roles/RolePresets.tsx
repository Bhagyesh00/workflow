/** P6-46: start a role from a preset (Admin, Editor, Viewer). */
import { customRoleAllowedScopes, GLOBAL_ROLE_SCOPES, PROJECT_ROLE_SCOPES } from '@workflow/workflow';
import { useState } from 'react';
import type { Scope } from '../../api/types';
import type { RoleKind } from '../../pages/RolesPages';
import { cx } from '../ui/cx';

export interface RolePresetsProps {
  roleType: RoleKind;
  onPick(scopes: Scope[]): void;
  disabled?: boolean;
}

interface Preset {
  key: string;
  label: string;
  source: ReadonlySet<Scope>;
}

/** project roles start from Admin, Editor or Viewer; workspace roles from the Admin or Member they build on */
function presetsFor(roleType: RoleKind): Preset[] {
  if (roleType === 'project') {
    return [
      { key: 'admin', label: 'Admin', source: PROJECT_ROLE_SCOPES['project:admin'] },
      { key: 'editor', label: 'Editor', source: PROJECT_ROLE_SCOPES['project:editor'] },
      { key: 'viewer', label: 'Viewer', source: PROJECT_ROLE_SCOPES['project:viewer'] },
    ];
  }
  return [
    { key: 'admin', label: 'Admin', source: GLOBAL_ROLE_SCOPES.admin },
    { key: 'member', label: 'Member', source: GLOBAL_ROLE_SCOPES.member },
  ];
}

/** a preset's scopes cut to what a custom role of the type may hold */
export function presetScopes(roleType: RoleKind, source: ReadonlySet<Scope>): Scope[] {
  const allowed = customRoleAllowedScopes(roleType);
  return [...source].filter((scope) => allowed.has(scope));
}

export function RolePresets({ roleType, onPick, disabled }: RolePresetsProps) {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <fieldset aria-label="Start from a preset" className="m-0 flex flex-wrap items-center gap-2 border-0 p-0">
      <span className="text-sm text-ink-2">Start from a preset</span>
      {presetsFor(roleType).map((preset) => (
        <button
          key={preset.key}
          type="button"
          disabled={disabled}
          aria-pressed={picked === preset.key}
          onClick={() => {
            setPicked(preset.key);
            onPick(presetScopes(roleType, preset.source));
          }}
          className={cx(
            'rounded-full border px-3 py-1 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            picked === preset.key
              ? 'border-brand bg-brand-soft text-brand'
              : 'border-line text-ink-2 hover:text-ink',
          )}
        >
          {preset.label}
        </button>
      ))}
    </fieldset>
  );
}
