/**
 * Credential selectors of a node, from `description.credentials` (filtered by displayOptions).
 * Credentials can be created or edited inline.
 */
import {
  isParameterDisplayed,
  type NodeCredentialDescription,
  type NodeTypeDescription,
  resolveNodeParameters,
  type WorkflowNode,
} from '@workflow/workflow';
import { Pencil, Plus } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useCredentials, useCredentialTypes } from '../../api/queries';
import { ExpressionInput } from '../parameters/ExpressionInput';
import { IconButton } from '../ui/Button';
import { Select } from '../ui/Field';
import { CredentialModal } from './CredentialModal';

const CREATE = '__create__';

function CredentialSelect({
  credential,
  node,
  readOnly,
  onSelect,
}: {
  credential: NodeCredentialDescription;
  node: WorkflowNode;
  readOnly: boolean;
  onSelect: (ref: { id: string; name: string } | null) => void;
}) {
  const id = useId();
  const types = useCredentialTypes();
  const list = useCredentials(credential.name);
  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; id: string } | null>(null);
  const current = node.credentials?.[credential.name];
  const typeLabel = types.get(credential.name)?.displayName ?? credential.name;

  // a credential slot (NF-05): the id is an expression resolved per item at run time
  const slot = typeof current?.id === 'string' && current.id.startsWith('=');

  // a single matching credential is selected automatically
  useEffect(() => {
    if (readOnly || current?.id || !list.data || list.data.length !== 1) return;
    onSelect({ id: list.data[0].id, name: list.data[0].name });
  }, [readOnly, current?.id, list.data, onSelect]);

  const missing = !slot && current?.id && list.data && !list.data.some((c) => c.id === current.id);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-sm font-semibold text-ink">
          Credential to connect with
          {credential.required && <span className="ml-0.5 text-err">*</span>}
        </label>
        {!readOnly && (
          <button
            type="button"
            aria-pressed={slot}
            onClick={() =>
              onSelect(slot ? null : { id: '={{ $json.credentialId }}', name: `${typeLabel} (per item)` })
            }
            className="ml-auto rounded-md px-1.5 py-0.5 text-2xs font-semibold text-ink-2 hover:bg-surface-3 hover:text-ink aria-pressed:bg-brand-soft aria-pressed:text-brand"
            title="Pick the credential from the data of each item, for example one account per customer"
          >
            Per item
          </button>
        )}
      </div>
      {slot && current ? (
        <div className="flex flex-col gap-1.5">
          <ExpressionInput
            value={String(current.id)}
            onChange={(value) => onSelect({ id: value, name: current.name })}
            ariaLabel={`${typeLabel} credential id expression`}
            showPreview
          />
          <p className="text-xs text-ink-3">
            Resolves to a credential id for each item. Only credentials of this workspace and of type{' '}
            {typeLabel} are used.
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <Select
            id={id}
            className="flex-1"
            disabled={readOnly}
            value={current?.id ?? ''}
            aria-invalid={Boolean(credential.required && !current?.id) || undefined}
            onChange={(e) => {
              if (e.target.value === CREATE) {
                setModal({ mode: 'create' });
                return;
              }
              const picked = list.data?.find((c) => c.id === e.target.value);
              onSelect(picked ? { id: picked.id, name: picked.name } : null);
            }}
          >
            <option value="">{list.isLoading ? 'Loading…' : `Select ${typeLabel}…`}</option>
            {missing && <option value={current.id ?? ''}>{current.name} (not found)</option>}
            {list.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {!readOnly && <option value={CREATE}>+ Create new credential</option>}
          </Select>
          {!readOnly && current?.id && !missing && (
            <IconButton
              label="Edit credential"
              size="sm"
              variant="secondary"
              onClick={() => setModal({ mode: 'edit', id: current.id! })}
            >
              <Pencil size={13} />
            </IconButton>
          )}
          {!readOnly && !current?.id && (
            <IconButton
              label="Create credential"
              size="sm"
              variant="secondary"
              onClick={() => setModal({ mode: 'create' })}
            >
              <Plus size={14} />
            </IconButton>
          )}
        </div>
      )}
      <CredentialModal
        open={Boolean(modal)}
        onClose={() => setModal(null)}
        type={modal?.mode === 'create' ? credential.name : null}
        credentialId={modal?.mode === 'edit' ? modal.id : null}
        onSaved={(saved) => onSelect({ id: saved.id, name: saved.name })}
      />
    </div>
  );
}

export function visibleCredentials(
  node: WorkflowNode,
  description: NodeTypeDescription,
): NodeCredentialDescription[] {
  const params = resolveNodeParameters(description.properties, node.parameters ?? {}, {
    nodeVersion: node.typeVersion,
  });
  return (description.credentials ?? []).filter((c) =>
    isParameterDisplayed(c.displayOptions, params, { nodeVersion: node.typeVersion, rootParams: params }),
  );
}

export function NodeCredentials({
  node,
  description,
  readOnly,
  onChange,
}: {
  node: WorkflowNode;
  description: NodeTypeDescription;
  readOnly: boolean;
  onChange: (credentials: WorkflowNode['credentials']) => void;
}) {
  const visible = visibleCredentials(node, description);
  if (!visible.length) return null;
  return (
    <div className="flex flex-col gap-4 border-b border-line pb-4">
      {visible.map((credential) => (
        <CredentialSelect
          key={credential.name}
          credential={credential}
          node={node}
          readOnly={readOnly}
          onSelect={(ref) => {
            const next = { ...(node.credentials ?? {}) };
            if (ref) next[credential.name] = ref;
            else delete next[credential.name];
            onChange(Object.keys(next).length ? next : undefined);
          }}
        />
      ))}
    </div>
  );
}
