/**
 * The connect panel identity triggers show when a run needs private credentials the visitor has not connected
 * (`@workflow/nodes-base/utils/connect-panel`; P6-87). The Form Trigger shows it in the form's page and the
 * hosted Chat in a bar and a dialog (nodes-ai chat-page.ts). It lists the accounts, "{n} of {m} connected", and a
 * link per account to the editor's connect page: a top-level navigation to `/credential-connect/:id?action=&returnTo=`
 * that carries no session and no token. Every value is escaped; the panel runs no script of its own.
 */
import type { CredentialGateHelper, WebhookContext } from '@workflow/workflow';

export interface ConnectPanelItem {
  credentialId: string;
  name: string;
  type: string;
  connected: boolean;
  /** the link of "Connect" (or "Reconnect" when connected) */
  connectUrl: string;
  /** the link of "Disconnect" */
  disconnectUrl: string;
}

export interface ConnectPanel {
  /** every account is connected: the page may submit */
  ready: boolean;
  /** the check itself failed (shown as one line, and the page cannot submit) */
  failed: boolean;
  connected: number;
  total: number;
  items: ConnectPanelItem[];
}

export const CONNECT_PANEL_TEXTS = {
  title: 'Connect your accounts',
  intro: 'This needs access to your accounts. Connect them, then come back and submit.',
  failed: "We couldn't check your connected accounts. Try again later.",
  connected: 'Connected',
  notConnected: 'Not connected',
  connect: 'Connect',
  reconnect: 'Reconnect',
  disconnect: 'Disconnect',
} as const;

/** "{n} of {m} connected" */
export const connectedCount = (panel: Pick<ConnectPanel, 'connected' | 'total'>) =>
  `${panel.connected} of ${panel.total} connected`;

const failedPanel = (): ConnectPanel => ({ ready: false, failed: true, connected: 0, total: 0, items: [] });

/**
 * The panel for a visitor the trigger identified, or undefined when there is nothing to connect (no gate on
 * this host, or the run reaches no private credential). A check that throws gives a panel that says so and
 * blocks the submit: the server refuses the run in that case too.
 */
export async function loadConnectPanel(
  ctx: WebhookContext,
  userId: string,
  returnTo: string,
): Promise<ConnectPanel | undefined> {
  const gate: CredentialGateHelper | undefined = ctx.getCredentialGate?.();
  if (!gate) return undefined;
  try {
    const result = await gate.check(userId);
    if (result.credentials.length === 0) return undefined;
    const items = result.credentials.map((credential) => ({
      credentialId: credential.credentialId,
      name: credential.credentialName,
      type: credential.credentialType,
      connected: credential.status === 'configured',
      connectUrl: gate.connectPageUrl(credential.credentialId, 'connect', returnTo),
      disconnectUrl: gate.connectPageUrl(credential.credentialId, 'disconnect', returnTo),
    }));
    const connected = items.filter((item) => item.connected).length;
    return { ready: result.readyToExecute, failed: false, connected, total: items.length, items };
  } catch {
    return failedPanel();
  }
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const escapeConnectText = (text: string) => String(text).replace(/[&<>"']/g, (c) => ENTITIES[c]);

/** a link of the panel goes to a page on a web address or this site, never to a script */
const safeHref = (url: string) => (/^(https?:\/\/|\/(?!\/))/i.test(url) ? url : '#');

/** the panel's markup (a `<section>`); no script, no inline handler */
export function renderConnectPanelHtml(panel: ConnectPanel): string {
  const t = CONNECT_PANEL_TEXTS;
  if (panel.failed) {
    return `<section class="connect-panel" aria-labelledby="connect-title"><h2 id="connect-title">${t.title}</h2><p class="connect-error" role="alert">${t.failed}</p></section>`;
  }
  const rows = panel.items
    .map((item) => {
      const link = (url: string, label: string) =>
        `<a class="connect-link" href="${escapeConnectText(safeHref(url))}">${label}</a>`;
      return `<li class="connect-item" data-status="${item.connected ? 'connected' : 'missing'}"><span class="connect-name">${escapeConnectText(item.name)}</span> <span class="connect-type">${escapeConnectText(item.type)}</span> <span class="connect-status">${item.connected ? t.connected : t.notConnected}</span> ${link(item.connectUrl, item.connected ? t.reconnect : t.connect)}${item.connected ? ` ${link(item.disconnectUrl, t.disconnect)}` : ''}</li>`;
    })
    .join('');
  return `<section class="connect-panel" aria-labelledby="connect-title"><h2 id="connect-title">${t.title}</h2>${panel.ready ? '' : `<p class="connect-intro">${t.intro}</p>`}<p class="connect-count">${escapeConnectText(connectedCount(panel))}</p><ul class="connect-list">${rows}</ul></section>`;
}

/** the panel's own style rules (no value of a workflow in them) */
export const CONNECT_PANEL_STYLES = `
.connect-panel{margin:0 0 20px;padding:14px 16px;border:1px solid #e3e3e8;border-radius:8px;background:#fafafc}
.connect-panel h2{margin:0 0 6px;font-size:16px}
.connect-intro{margin:0 0 8px;color:#55555f}
.connect-count{margin:0 0 8px;font-weight:600}
.connect-list{margin:0;padding:0;list-style:none}
.connect-item{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;padding:6px 0;border-top:1px solid #ececf0}
.connect-name{font-weight:600}
.connect-type{color:#77777f;font-size:13px}
.connect-status{font-size:13px}
.connect-item[data-status=missing] .connect-status{color:#8f1f1f}
.connect-item[data-status=connected] .connect-status{color:#1d6b3a}
.connect-link{color:#5b4fd6}
.connect-error{margin:0;color:#8f1f1f}
`;

/** a CSP for a page that shows the panel: nothing loads from outside, forms and fetches stay on the page's own address */
export const CONNECT_PANEL_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'self'";
