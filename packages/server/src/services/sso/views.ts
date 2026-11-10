/**
 * P6-09 (L7): the two pages the SAML routes render. The POST page sends the sign-in request to the identity
 * provider (POST binding): it carries its own CSP, with the identity provider's origin in `form-action` and a
 * nonce for its one script, because the app's CSP allows `form-action 'self'` only. The test result page shows
 * what a test sign-in mapped and which attributes the identity provider sent; it has no script. Every value is
 * HTML-escaped.
 */

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"'`]/g, (char) => ESCAPES[char] ?? char);
}

/** the origin a form may post to: http(s) only, else nothing (the page then posts nowhere) */
function formOrigin(action: string): string {
  try {
    const url = new URL(action);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : "'none'";
  } catch {
    return "'none'";
  }
}

/** the POST page's own CSP: the script by nonce, the form to the identity provider's origin only */
export function samlPostCsp(action: string, nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    `form-action ${formOrigin(action)}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** an auto-submitting form to the identity provider (POST binding); without script, a Continue button */
export function samlPostPage(input: {
  action: string;
  fields: Record<string, string>;
  nonce: string;
}): string {
  const inputs = Object.entries(input.fields)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('');
  const nonce = escapeHtml(input.nonce);
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">',
    '<title>Signing in</title>',
    `<style nonce="${nonce}">body{font-family:system-ui,sans-serif;margin:3rem;color:#1f2328}</style>`,
    '</head><body>',
    `<form id="saml-form" method="post" action="${escapeHtml(input.action)}">${inputs}`,
    '<p>Sending you to your identity provider.</p>',
    '<noscript><button type="submit">Continue</button></noscript>',
    '</form>',
    `<script nonce="${nonce}">document.getElementById('saml-form').submit();</script>`,
    '</body></html>',
  ].join('');
}

/** the test result page's CSP: no script, no form, inline styles only */
export const SAML_TEST_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** what a test sign-in found */
export type SamlTestOutcome =
  | {
      ok: true;
      /** the mapped values: email, first name, last name, user principal name */
      mapped: Record<string, string>;
      /** every attribute the identity provider sent, by name */
      attributes: Record<string, unknown>;
    }
  | {
      ok: false;
      message: string;
      /** the mapped attribute names the response did not carry */
      missing?: string[];
      attributes?: Record<string, unknown>;
    };

function valueText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => valueText(item)).join(', ');
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '');
}

function table(rows: Array<[string, unknown]>): string {
  if (!rows.length) return '<p>None.</p>';
  const body = rows
    .map(
      ([name, value]) =>
        `<tr><th scope="row">${escapeHtml(name)}</th><td>${escapeHtml(valueText(value))}</td></tr>`,
    )
    .join('');
  return `<table>${body}</table>`;
}

/** the page a test sign-in ends on; it never signs anyone in */
export function samlTestResultPage(outcome: SamlTestOutcome): string {
  const heading = outcome.ok ? 'SAML test passed' : 'SAML test failed';
  const parts = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">',
    `<title>${heading}</title>`,
    '<style>body{font-family:system-ui,sans-serif;margin:2rem;color:#1f2328;max-width:60rem}',
    'table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:.4rem .6rem;',
    'text-align:left;vertical-align:top;word-break:break-all}th{width:35%;font-weight:600}',
    '.ok{color:#1a7f37}.fail{color:#cf222e}</style>',
    '</head><body>',
    `<h1 class="${outcome.ok ? 'ok' : 'fail'}">${heading}</h1>`,
  ];
  if (outcome.ok) {
    parts.push(
      '<p>The identity provider signed you in and sent the attributes below. Nobody was signed in to the workspace.</p>',
      '<h2>Mapped attributes</h2>',
      table(Object.entries(outcome.mapped)),
      '<h2>All attributes</h2>',
      table(Object.entries(outcome.attributes)),
    );
  } else {
    parts.push(`<p>${escapeHtml(outcome.message)}</p>`);
    if (outcome.missing?.length) {
      parts.push(
        '<h2>Missing attributes</h2>',
        `<ul>${outcome.missing.map((name) => `<li>${escapeHtml(name)}</li>`).join('')}</ul>`,
      );
    }
    if (outcome.attributes) parts.push('<h2>Attributes sent</h2>', table(Object.entries(outcome.attributes)));
  }
  parts.push('<p>You can close this window.</p>', '</body></html>');
  return parts.join('');
}
