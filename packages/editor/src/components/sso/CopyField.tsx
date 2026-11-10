/** P6-13: a read-only value the admin gives the identity provider (entity ID, ACS URL, redirect URL) with a Copy button. */
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../ui/Button';
import { FormField, TextInput } from '../ui/Field';

export function CopyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // no clipboard here: the admin selects the text in the box
      setCopied(false);
    }
  };
  return (
    <FormField label={label} hint={hint}>
      {(id) => (
        <div className="flex gap-2">
          <TextInput
            id={id}
            readOnly
            value={value}
            className="flex-1 font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button
            type="button"
            icon={copied ? <Check size={14} /> : <Copy size={14} />}
            aria-label={`Copy ${label}`}
            onClick={copy}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}
    </FormField>
  );
}
