/**
 * The hosted chat page (P5-56): a classic `<script src="/chat-widget/chat.js">`, the widget's CSS, one
 * `<script type="application/json" id="chat-config">` blob and a small bootstrap with no inline handler,
 * served under the sandbox CSP. The page runs in an opaque origin, so it never touches browser storage or
 * cookies: the widget keeps the session id in memory and in the URL fragment (`#sessionId=...`).
 */
import {
  CONNECT_PANEL_STYLES,
  CONNECT_PANEL_TEXTS,
  type ConnectPanel,
  connectedCount,
  escapeConnectText,
  renderConnectPanelHtml,
} from '@workflow/nodes-base/utils/connect-panel';
import { CHAT_AUTH_HEADER, CHAT_PAGE_HEADER, type ChatPageConfig } from '@workflow/workflow';

/** where the server serves the built widget (routes/chat-widget.ts) */
const WIDGET_SCRIPT = '/chat-widget/chat.js';
const WIDGET_STYLES = '/chat-widget/chat.css';

const SCRIPT_ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/** JSON made safe inside a `<script>` element: `<`, `>`, `&`, U+2028 and U+2029 escaped */
export function escapeForScript(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, (c) => SCRIPT_ESCAPES[c] ?? c);
}

/** text for an HTML element or a quoted attribute */
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Reads the blob, applies the custom CSS as text, resolves the chat URL against the page and mounts the
 * widget full screen. Header names are fixed constants; every value comes from the blob at run time.
 */
const BOOTSTRAP = `(function () {
  var config = JSON.parse(document.getElementById('chat-config').textContent);
  if (config.customCss) {
    var style = document.createElement('style');
    style.textContent = config.customCss;
    document.head.appendChild(style);
  }
  var headers = {};
  headers[${JSON.stringify(CHAT_PAGE_HEADER)}] = config.pageToken;
  if (config.authToken) headers[${JSON.stringify(CHAT_AUTH_HEADER)}] = config.authToken;
  window.WorkflowChat.createChat({
    webhookUrl: new URL(config.webhookUrl, window.location.href).href,
    webhookConfig: { method: 'POST', headers: headers },
    target: '#chat',
    mode: 'fullscreen',
    showWelcomeScreen: config.showWelcomeScreen,
    loadPreviousSession: config.loadPreviousSession,
    initialMessages: config.initialMessages,
    allowFileUploads: config.allowFileUploads,
    allowedFilesMimeTypes: config.allowedFilesMimeTypes,
    enableStreaming: config.enableStreaming,
    i18n: {
      en: {
        title: config.title,
        subtitle: config.subtitle,
        inputPlaceholder: config.inputPlaceholder,
        getStarted: config.getStarted,
      },
    },
  });
})();`;

/**
 * Opens and closes the connect dialog. No value of a workflow is in this text: the dialog is rendered with the
 * page (escaped), and `data-open` says whether it opens by itself.
 */
const CONNECT_SCRIPT = `(function () {
  var dialog = document.getElementById('connect-dialog');
  var open = document.getElementById('connect-open');
  if (!dialog || !open || typeof dialog.showModal !== 'function') return;
  open.addEventListener('click', function () { dialog.showModal(); });
  if (dialog.hasAttribute('data-open')) dialog.showModal();
})();`;

const CONNECT_BAR_STYLES = `${CONNECT_PANEL_STYLES}
#connect-bar{position:fixed;left:12px;bottom:12px;z-index:2147483000;font:14px/1.4 system-ui,sans-serif}
#connect-open{padding:8px 14px;border:1px solid #c9c9d1;border-radius:999px;background:#fff;color:#1f1f24;cursor:pointer;font:inherit;box-shadow:0 1px 4px rgba(0,0,0,.15)}
#connect-open[data-ready=false]{border-color:#c02b2b;color:#8f1f1f}
#connect-dialog{max-width:480px;width:calc(100% - 32px);border:1px solid #c9c9d1;border-radius:10px;padding:16px;font:14px/1.5 system-ui,sans-serif}
#connect-dialog form{margin:12px 0 0;text-align:right}
#connect-dialog button{padding:6px 14px;border:0;border-radius:6px;background:#5b4fd6;color:#fff;font:inherit;cursor:pointer}`;

/**
 * P6-87: a hosted chat with user sign-in shows a bar ("Connect your accounts", "{n} of {m} connected") and a
 * dialog that lists the accounts the run needs, with a link per account to the connect page (a top-level
 * navigation, no session or token in it). The dialog opens by itself while an account is missing. Values are
 * escaped; the one script is fixed text.
 */
export function renderChatConnectBar(panel: ConnectPanel): {
  styles: string;
  markup: string;
  script: string;
} {
  const ready = panel.ready && !panel.failed;
  const label = panel.failed
    ? CONNECT_PANEL_TEXTS.failed
    : `${CONNECT_PANEL_TEXTS.title} (${connectedCount(panel)})`;
  const markup = [
    `<div id="connect-bar"><button type="button" id="connect-open" data-ready="${ready}">${escapeConnectText(label)}</button></div>`,
    `<dialog id="connect-dialog" aria-label="${escapeConnectText(CONNECT_PANEL_TEXTS.title)}"${ready ? '' : ' data-open'}>`,
    renderConnectPanelHtml(panel),
    '<form method="dialog"><button type="submit">Close</button></form>',
    '</dialog>',
  ].join('');
  return { styles: CONNECT_BAR_STYLES, markup, script: CONNECT_SCRIPT };
}

/** the chat page with the connect bar and dialog added; a page without a body is returned as it is */
export function injectChatConnectBar(page: string, panel: ConnectPanel): string {
  const bar = renderChatConnectBar(panel);
  if (!page.includes('</head>') || !page.includes('</body>')) return page;
  return page
    .replace('</head>', () => `<style>${bar.styles}</style>\n</head>`)
    .replace('</body>', () => `${bar.markup}\n<script>${bar.script}</script>\n</body>`);
}

/** the whole page for one chat; every value of `config` is escaped for its context */
export function renderChatPage(config: ChatPageConfig): string {
  const blob = escapeForScript(JSON.stringify(config));
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${escapeHtml(config.title || 'Chat')}</title>`,
    `<link rel="stylesheet" href="${WIDGET_STYLES}">`,
    '<style>html,body{margin:0;height:100%}#chat{height:100%}</style>',
    '</head>',
    '<body>',
    '<div id="chat"></div>',
    `<script type="application/json" id="chat-config">${blob}</script>`,
    `<script src="${WIDGET_SCRIPT}"></script>`,
    `<script>${BOOTSTRAP}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}
