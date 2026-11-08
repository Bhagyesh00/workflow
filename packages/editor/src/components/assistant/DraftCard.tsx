/**
 * P5-70 (L7): a draft the Assistant built: name, node count, the diff (`ParameterDiff`), credentials Accept
 * assigns, Accept and Discard. Loads the draft itself (features/assistant/draft-actions.ts) from the reference.
 *
 * Nothing is saved until a person presses Accept (editor and above; a viewer sees why the buttons are off). A
 * refused Accept stays in the card with the server's reason (a changed workflow: build again or open it). Every
 * name and value is rendered as text.
 */
import { Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../../api/client';
import { useMe } from '../../api/queries';
import type { AssistantDraftArtifact, AssistantDraftView } from '../../api/types';
import { acceptDraft, discardDraft, loadDraft } from '../../features/assistant/draft-actions';
import { useAssistantStore } from '../../stores/assistant-store';
import { Button } from '../ui/Button';
import { Badge, Callout, Spinner } from '../ui/misc';
import { ParameterDiff } from './ParameterDiff';

export interface DraftCardProps {
  draft: AssistantDraftArtifact;
}

/** what Accept and Discard need beyond a viewer */
const EDIT_ROLES = new Set(['owner', 'admin', 'editor']);
export const DRAFT_VIEWER_REASON = 'Only editors and above can save or discard a draft';

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

function statusBadge(status: AssistantDraftView['draft']['status']) {
  if (status === 'accepted') return <Badge tone="ok">Saved</Badge>;
  if (status === 'discarded') return <Badge>Discarded</Badge>;
  return <Badge tone="brand">Draft</Badge>;
}

/** the nodes the draft adds, removes and renames, as short lines */
function NodeChanges({ view }: { view: AssistantDraftView }) {
  const { added, removed, renamed } = view.diff.nodes;
  const lines = [
    ...added.map((n) => ({ key: `add-${n.id}`, text: `Adds ${n.name}` })),
    ...removed.map((n) => ({ key: `remove-${n.id}`, text: `Removes ${n.name}` })),
    ...renamed.map((n) => ({ key: `rename-${n.id}`, text: `Renames ${n.from} to ${n.to}` })),
  ];
  const connections = view.diff.connections;
  if (connections.added.length) {
    lines.push({ key: 'connections-added', text: `Adds ${plural(connections.added.length, 'connection')}` });
  }
  if (connections.removed.length) {
    lines.push({
      key: 'connections-removed',
      text: `Removes ${plural(connections.removed.length, 'connection')}`,
    });
  }
  if (!lines.length) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-sm text-ink-2">
      {lines.map((line) => (
        <li key={line.key} className="min-w-0 break-words">
          {line.text}
        </li>
      ))}
    </ul>
  );
}

export function DraftCard({ draft }: DraftCardProps) {
  const threadId = useAssistantStore((s) => s.activeThreadId);
  const view = useAssistantStore((s) => s.drafts[draft.draftId]) as AssistantDraftView | undefined;
  const me = useMe();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ kind: 'accept' | 'discard'; message: string } | null>(
    null,
  );
  const [busy, setBusy] = useState<'accept' | 'discard' | null>(null);

  useEffect(() => {
    if (!threadId || view) return;
    let live = true;
    setLoadError(null);
    loadDraft(threadId, draft.draftId).catch((error) => {
      if (live) setLoadError(errorMessage(error));
    });
    return () => {
      live = false;
    };
  }, [threadId, draft.draftId, view]);

  const label = `Draft ${draft.name}`;
  if (!view) {
    return (
      <section aria-label={label} className="rounded-lg border border-line bg-surface-2 p-3 text-sm">
        {loadError ? (
          <Callout tone="err" title="Couldn't load the draft">
            {loadError}
          </Callout>
        ) : (
          <p className="flex items-center gap-2 text-ink-2">
            <Spinner /> Loading the draft
          </p>
        )}
      </section>
    );
  }

  const { status, workflowId, nodeCount, issues } = view.draft;
  const role = me.data?.role;
  const canEdit = role ? EDIT_ROLES.has(role) : false;
  const open = status === 'open';
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  const changed = view.diff.nodes.changed.filter((change) => change.changes.length > 0);

  const run = async (kind: 'accept' | 'discard') => {
    if (!threadId) return;
    setBusy(kind);
    setActionError(null);
    try {
      if (kind === 'accept') await acceptDraft(threadId, draft.draftId);
      else await discardDraft(threadId, draft.draftId);
    } catch (error) {
      setActionError({ kind, message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      aria-label={label}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Workflow size={14} aria-hidden="true" className="shrink-0" />
        <p className="m-0 min-w-0 flex-1 break-words text-sm font-semibold text-ink">{view.draft.name}</p>
        {statusBadge(status)}
      </div>
      <p className="m-0 text-xs text-ink-2">
        {plural(nodeCount, 'node')}
        {view.draft.workflowId && open ? ' · changes a saved workflow' : open ? ' · a new workflow' : ''}
        {errors > 0 ? ` · ${plural(errors, 'error')}` : ''}
        {warnings > 0 ? ` · ${plural(warnings, 'warning')}` : ''}
      </p>

      <NodeChanges view={view} />
      {changed.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2">
          {changed.map((change) => (
            <ParameterDiff key={change.id} change={change} />
          ))}
        </div>
      )}

      {open && view.assignments.length > 0 && (
        <div className="text-sm">
          <p className="m-0 text-xs font-semibold text-ink-2">Credentials Accept sets</p>
          <ul className="m-0 list-none p-0">
            {view.assignments.map((a) => (
              <li key={`${a.nodeName}-${a.credentialType}`} className="min-w-0 break-words text-ink">
                {`${a.nodeName}: ${a.credentialName}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {actionError && (
        <Callout
          tone="err"
          title={actionError.kind === 'accept' ? "Couldn't save the draft" : "Couldn't discard the draft"}
        >
          {actionError.message}
          {workflowId && (
            <>
              {' '}
              <Link className="font-semibold text-brand hover:underline" to={`/workflow/${workflowId}`}>
                Open the workflow
              </Link>
            </>
          )}
        </Callout>
      )}

      {open ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={!canEdit || busy !== null}
            loading={busy === 'accept'}
            onClick={() => void run('accept')}
          >
            Accept
          </Button>
          <Button
            disabled={!canEdit || busy !== null}
            loading={busy === 'discard'}
            onClick={() => void run('discard')}
          >
            Discard
          </Button>
          {!canEdit && role && <span className="text-xs text-ink-2">{DRAFT_VIEWER_REASON}</span>}
        </div>
      ) : status === 'accepted' && workflowId ? (
        <p className="m-0 text-sm text-ink-2">
          Saved as a workflow.{' '}
          <Link className="font-semibold text-brand hover:underline" to={`/workflow/${workflowId}`}>
            Open workflow
          </Link>
        </p>
      ) : (
        <p className="m-0 text-sm text-ink-2">Discarded. Nothing was saved.</p>
      )}
    </section>
  );
}
