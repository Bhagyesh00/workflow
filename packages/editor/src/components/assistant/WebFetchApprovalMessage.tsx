/**
 * P5-64: asks the user to let the builder read one web page (Approve or Deny). The website is shown as
 * plain text; Approve lets the builder read pages of that exact website in this chat, Deny leaves it
 * out. Nothing is read until the user approves.
 */
import { Globe } from 'lucide-react';
import { decideWebFetch } from '../../features/builder/web-fetch-actions';
import { useBuilderStore } from '../../stores/builder-store';
import { Button } from '../ui/Button';

export interface WebFetchApprovalMessageProps {
  url: string;
  domain: string;
}

export function WebFetchApprovalMessage({ url, domain }: WebFetchApprovalMessageProps) {
  const streaming = useBuilderStore((s) => s.streaming);
  return (
    <fieldset
      aria-label="Web page approval"
      className="m-0 flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3"
    >
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Globe size={14} aria-hidden="true" />
        Read a web page?
      </p>
      <p className="text-sm text-ink-2">
        The builder wants to read a page on <strong className="font-semibold text-ink">{domain}</strong>.
        Approving lets it read pages on this website in this chat.
      </p>
      <p className="break-all rounded border border-line px-2 py-1 font-mono text-xs text-ink-2" title={url}>
        {url}
      </p>
      <div className="flex gap-2">
        <Button variant="primary" disabled={streaming} onClick={() => void decideWebFetch(url, 'approve')}>
          Approve
        </Button>
        <Button variant="secondary" disabled={streaming} onClick={() => void decideWebFetch(url, 'deny')}>
          Deny
        </Button>
      </div>
    </fieldset>
  );
}
