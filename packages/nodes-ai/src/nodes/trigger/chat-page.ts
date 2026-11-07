/**
 * The hosted chat page (P5-56): a classic `<script src="/chat-widget/chat.js">`, the widget's CSS, one
 * `<script type="application/json" id="chat-config">` blob and a small bootstrap with no inline handler,
 * served under the sandbox CSP. The page runs in an opaque origin, so it never touches browser storage or
 * cookies: the widget keeps the session id in memory and in the URL fragment (`#sessionId=...`).
 */
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
