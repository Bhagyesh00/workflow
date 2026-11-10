/** P6-16: the JWKS URI to give the provider, copy only, when an OAuth2 credential has JWE on. */
import { Copy } from 'lucide-react';
import { useMe } from '../../api/queries';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';

export interface JweUriRowProps {
  /** the credential type's name */
  typeName: string;
  /** the form's `jweEnabled` value */
  jweEnabled: boolean;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Key URL copied');
  } catch {
    toast.error("Couldn't copy the key URL", 'Select the text and copy it by hand.');
  }
}

export function JweUriRow({ typeName, jweEnabled }: JweUriRowProps) {
  const me = useMe();
  // only the generic OAuth2 type has the field
  if (typeName !== 'oAuth2Api' || !jweEnabled) return null;
  const slug = me.data?.tenant.slug;
  if (!slug) return null;
  const uri = `${window.location.origin}/.well-known/jwks/${encodeURIComponent(slug)}.json`;
  return (
    <div className="flex flex-col gap-1.5" data-testid="jwe-uri-row">
      <span className="text-sm font-medium text-ink">Public key URL</span>
      <p className="text-xs text-ink-2">
        Give this address to the provider so it can encrypt its tokens for this workspace.
      </p>
      <div className="flex items-start gap-2">
        <figure aria-label="Public key URL" className="m-0 min-w-0 flex-1">
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs">
            {uri}
          </pre>
        </figure>
        <Button
          size="sm"
          icon={<Copy size={14} />}
          aria-label="Copy public key URL"
          onClick={() => void copyText(uri)}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}
