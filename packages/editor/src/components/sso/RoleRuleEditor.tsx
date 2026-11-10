/**
 * P6-11: the dialog that adds or edits one role mapping rule: an expression over `$claims`, the role it gives and,
 * for a project rule, the projects. The server runs the dry run and answers a bad expression with its reason.
 */
import { useState } from 'react';
import type { CustomRole, ProjectRef, RoleMappingRule, RoleMappingRuleBody } from '../../api/types';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Checkbox, FormField, Select, TextArea } from '../ui/Field';
import { Callout } from '../ui/misc';

export const RULE_EXPRESSION_MAX = 2000;

export function RoleRuleEditor({
  type,
  rule,
  roles,
  projects,
  saving,
  error,
  onSave,
  onClose,
}: {
  type: 'instance' | 'project';
  /** null: a new rule */
  rule: RoleMappingRule | null;
  roles: CustomRole[];
  projects: ProjectRef[];
  saving: boolean;
  error: string | null;
  onSave: (body: RoleMappingRuleBody) => void;
  onClose: () => void;
}) {
  const [expression, setExpression] = useState(rule?.expression ?? '');
  const [role, setRole] = useState(rule?.role ?? roles[0]?.slug ?? '');
  const [projectIds, setProjectIds] = useState<string[]>(rule?.projectIds ?? []);
  const [touched, setTouched] = useState(false);

  const problem = !expression.trim()
    ? 'Write the condition.'
    : expression.length > RULE_EXPRESSION_MAX
      ? `Use at most ${RULE_EXPRESSION_MAX} characters.`
      : !role
        ? 'Pick the role this rule gives.'
        : type === 'project' && projectIds.length === 0
          ? 'Pick at least one project.'
          : null;

  const submit = () => {
    setTouched(true);
    if (problem) return;
    onSave(type === 'project' ? { type, expression, role, projectIds } : { type, expression, role });
  };
  const toggleProject = (id: string) =>
    setProjectIds((current) => (current.includes(id) ? current.filter((p) => p !== id) : [...current, id]));

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!saving}
      title={rule ? 'Edit rule' : type === 'project' ? 'Add project rule' : 'Add workspace rule'}
      description="A rule matches when its condition is true for the sign-in claims. The first matching rule in the list gives the role."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={submit}>
            {rule ? 'Save rule' : 'Add rule'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {error && <Callout tone="err">{error}</Callout>}
        <FormField
          label="Condition"
          hint="Reads the claims as $claims, for example {{ $claims.groups.includes('engineering') }}. Only true matches; an error counts as false."
          error={touched && !expression.trim() ? problem : undefined}
        >
          {(id) => (
            <TextArea
              id={id}
              rows={3}
              value={expression}
              className="font-mono text-xs"
              onChange={(event) => setExpression(event.target.value)}
            />
          )}
        </FormField>
        <FormField label="Role to give">
          {(id) => (
            <Select id={id} value={role} onChange={(event) => setRole(event.target.value)}>
              {roles.map((r) => (
                <option key={r.slug} value={r.slug}>
                  {r.displayName}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        {type === 'project' && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm font-semibold text-ink">Projects</legend>
            {projects.length === 0 && <p className="text-sm text-ink-2">There are no team projects yet.</p>}
            {projects.map((project) => (
              <Checkbox
                key={project.id}
                label={project.name}
                checked={projectIds.includes(project.id)}
                onChange={() => toggleProject(project.id)}
              />
            ))}
            {touched && projectIds.length === 0 && problem && <p className="text-xs text-err">{problem}</p>}
          </fieldset>
        )}
      </form>
    </Dialog>
  );
}
