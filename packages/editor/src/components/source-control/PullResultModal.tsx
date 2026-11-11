/**
 * P6-76 (L6): what a pull did, in n8n's groups: created, updated and deleted files, publishing errors, and the
 * workflows the content policy skipped. Open while `result` is set.
 */
import type { PullResult, SourceControlledFile } from '../../api/types';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Callout } from '../ui/misc';

export interface PullResultModalProps {
  /** open while set */
  result: PullResult | null;
  onClose(): void;
}

function FileSection({ title, files }: { title: string; files: SourceControlledFile[] }) {
  if (files.length === 0) return null;
  return (
    <section aria-label={title}>
      <h3 className="mb-1 text-sm font-semibold text-ink">
        {title} <span className="font-normal text-ink-2">({files.length})</span>
      </h3>
      <ul className="flex flex-col gap-0.5 text-sm">
        {files.map((file) => (
          <li key={`${file.type}:${file.id}`} className="flex items-baseline gap-2">
            <span className="truncate">{file.name}</span>
            <span className="text-xs text-ink-2">{file.type}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PullResultModal({ result, onClose }: PullResultModalProps) {
  const files = result?.files ?? [];
  const created = files.filter((f) => f.status === 'created' || f.status === 'new');
  const deleted = files.filter((f) => f.status === 'deleted');
  const updated = files.filter((f) => !created.includes(f) && !deleted.includes(f));
  const errors = result?.publishingErrors ?? [];
  const skipped = result?.contentImportPolicy ?? [];
  return (
    <Dialog
      open={result !== null}
      onClose={onClose}
      title="Pull finished"
      size="md"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
        {files.length === 0 && errors.length === 0 && skipped.length === 0 && (
          <p className="text-sm text-ink-2">Nothing changed. This workspace already matched the remote.</p>
        )}
        <FileSection title="Created" files={created} />
        <FileSection title="Updated" files={updated} />
        <FileSection title="Deleted" files={deleted} />
        {errors.length > 0 && (
          <section aria-label="Publishing errors">
            <Callout tone="err" title="Publishing errors">
              <ul className="mt-1 flex flex-col gap-1">
                {errors.map((error) => (
                  <li key={error.id}>
                    <strong>{error.name}</strong>: {error.message}
                  </li>
                ))}
              </ul>
            </Callout>
          </section>
        )}
        {skipped.length > 0 && (
          <section aria-label="Skipped by the content policy">
            <Callout tone="warn" title="Skipped by the content policy">
              <ul className="mt-1 flex flex-col gap-1.5">
                {skipped.map((item) => (
                  <li key={item.id}>
                    <strong>{item.name}</strong>
                    <ul className="ml-4 list-disc">
                      {item.violations.map((violation) => (
                        <li key={violation}>{violation}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </Callout>
          </section>
        )}
      </div>
    </Dialog>
  );
}
