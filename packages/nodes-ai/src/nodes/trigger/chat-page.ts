/**
 * The hosted chat page (P5-56): a classic `<script src="/chat-widget/chat.js">`, the widget's CSS, one
 * `<script type="application/json" id="chat-config">` blob and a small bootstrap with no inline handler,
 * served under the sandbox CSP. No storage, no cookie. Stub from C0: lane L2 writes it.
 */
import type { ChatPageConfig } from '@workflow/workflow';

/** the whole page for one chat; every value of `config` is escaped for its context */
export function renderChatPage(_config: ChatPageConfig): string {
  throw new Error('not implemented (L2)');
}

/** JSON made safe inside a `<script>` element: `<`, `>`, `&`, U+2028 and U+2029 escaped */
export function escapeForScript(_json: string): string {
  throw new Error('not implemented (L2)');
}
