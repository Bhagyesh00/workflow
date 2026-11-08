/** P5-14, P5-15: the workspace's allowed OAuth callback URLs (admins); empty means any URL a client registered. */
import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { FormField, TextArea } from '../ui/Field';
import { Callout } from '../ui/misc';

const REFUSED_SCHEMES = ['javascript:', 'data:', 'vbscript:', 'file:'];
const LOOPBACK = /^(localhost|::1|127(\.\d{1,3}){3})$/;

/**
 * Why a redirect URI is refused, or null: the rule of the server's client registration (no `javascript:`,
 * `data:`, `vbscript:`, `file:`, no fragment, no spaces, absolute, no user name, http only on loopback).
 * The consent page applies it to the address it is about to leave for.
 */
export function redirectUriProblem(uri: string): string | null {
  if (!uri) return 'A redirect URI must not be empty';
  if (uri.length > 2048) return 'A redirect URI may have at most 2048 characters';
  const lower = uri.trim().toLowerCase();
  if (REFUSED_SCHEMES.some((scheme) => lower.startsWith(scheme))) return 'This redirect URI scheme is not allowed';
  if (uri.includes('#')) return 'A redirect URI must not have a fragment';
  if (/\s/.test(uri)) return 'A redirect URI must not contain spaces';
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'A redirect URI must be an absolute URL';
  }
  if (REFUSED_SCHEMES.includes(url.protocol)) return 'This redirect URI scheme is not allowed';
  if (url.username || url.password) return 'A redirect URI must not hold a user name or password';
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol === 'http:' && !LOOPBACK.test(host)) {
    return 'A redirect URI may use http only on a loopback host (localhost, 127.0.0.1, [::1])';
  }
  if ((url.protocol === 'http:' || url.protocol === 'https:') && !host) return 'A redirect URI must name a host';
  return null;
}

function parse(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

export function McpRedirectUris({
  value,
  saving,
  onSave,
}: {
  value: string[];
  saving: boolean;
  onSave: (uris: string[]) => void;
}) {
  const [text, setText] = useState(value.join('\n'));
  const saved = value.join('\n');
  // the saved list changed (loaded, or saved): show it
  useEffect(() => {
    setText(saved);
  }, [saved]);
  const uris = parse(text);
  const problems = uris.map((uri) => ({ uri, problem: redirectUriProblem(uri) })).filter((p) => p.problem);
  const unchanged = uris.join('\n') === saved;
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4" aria-labelledby="mcp-uris">
      <div>
        <h3 id="mcp-uris" className="text-md font-semibold">
          Callback URLs
        </h3>
        <p className="mt-1 text-sm text-ink-2">
          Where an MCP client may send people back after they approve it. Leave empty to accept any URL a client
          registered. Loopback URLs (localhost) match on any port.
        </p>
      </div>
      <FormField label="Allowed callback URLs" hint="One URL per line.">
        {(id) => (
          <TextArea
            id={id}
            rows={4}
            value={text}
            spellCheck={false}
            placeholder="https://client.example.com/callback"
            onChange={(e) => setText(e.target.value)}
          />
        )}
      </FormField>
      {problems.length > 0 && (
        <Callout tone="err" title="Fix these URLs first">
          <ul className="list-disc pl-5">
            {problems.map((p) => (
              <li key={p.uri}>
                <span className="break-all">{p.uri}</span>: {p.problem}
              </li>
            ))}
          </ul>
        </Callout>
      )}
      <div>
        <Button
          variant="primary"
          loading={saving}
          disabled={saving || unchanged || problems.length > 0}
          onClick={() => onSave(uris)}
        >
          Save callback URLs
        </Button>
      </div>
    </section>
  );
}
