/**
 * P5-67 (L2): what the thread made (`artifact` events): workflows (`WorkflowPreview`), data tables
 * (`DataTablePreview`) and drafts, each with Open. A workflow or a table opens its preview in a dialog; a draft
 * opens its card in the thread (`DraftCard`, L7), where it is accepted or discarded.
 */
import type { AssistantArtifact } from '@workflow/workflow';
import { FileDiff, Table2, Workflow } from 'lucide-react';
import { useState } from 'react';
import { artifactKey } from '../../features/assistant/event-reducer';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { DataTablePreview } from './DataTablePreview';
import { WorkflowPreview } from './WorkflowPreview';

export interface ArtifactsPanelProps {
  artifacts: AssistantArtifact[];
}

const KIND: Record<AssistantArtifact['type'], string> = {
  workflow: 'Workflow',
  'data-table': 'Data table',
  draft: 'Draft',
};

/** the element id of a draft's card in the thread */
export function draftCardElementId(draftId: string): string {
  return `assistant-draft-${draftId}`;
}

function ArtifactIcon({ artifact }: { artifact: AssistantArtifact }) {
  if (artifact.type === 'workflow') return <Workflow size={15} aria-hidden />;
  if (artifact.type === 'data-table') return <Table2 size={15} aria-hidden />;
  return <FileDiff size={15} aria-hidden />;
}

type Previewed = Exclude<AssistantArtifact, { type: 'draft' }>;

export function ArtifactsPanel({ artifacts }: ArtifactsPanelProps) {
  const [preview, setPreview] = useState<Previewed | null>(null);

  const open = (artifact: AssistantArtifact) => {
    if (artifact.type === 'draft') {
      const card = document.getElementById(draftCardElementId(artifact.draftId));
      card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card?.focus?.();
      return;
    }
    setPreview(artifact);
  };

  return (
    <section className="flex min-h-0 flex-col gap-2" aria-label="Artifacts">
      <h2 className="font-sans text-sm font-semibold text-ink">Artifacts</h2>
      {artifacts.length === 0 ? (
        <p className="text-xs text-ink-2">Workflows and tables the Assistant makes or finds show here.</p>
      ) : (
        <ul className="wf-scroll flex min-h-0 flex-col gap-1.5 overflow-y-auto">
          {artifacts.map((artifact) => (
            <li
              key={artifactKey(artifact)}
              className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-2"
            >
              <span className="text-ink-2">
                <ArtifactIcon artifact={artifact} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{artifact.name}</span>
                <span className="block text-xs text-ink-2">{KIND[artifact.type]}</span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Open ${artifact.name}`}
                onClick={() => open(artifact)}
              >
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={preview ? `${KIND[preview.type]}: ${preview.name}` : ''}
        size="xl"
      >
        {preview?.type === 'workflow' && <WorkflowPreview workflowId={preview.id} />}
        {preview?.type === 'data-table' && <DataTablePreview dataTableId={preview.id} />}
      </Dialog>
    </section>
  );
}
