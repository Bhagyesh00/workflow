/**
 * The tool loop of vendor message operations: a chat model over the node's own `ExecuteContext` (an
 * `HttpChatModel` on a `ChatAdapter`, or the caller's model) run through `runAgent` with the connected
 * tools. L1 fills these; the signatures are final.
 */
import type { AiChatMessage, AiChatModel, ExecuteContext } from '@workflow/workflow';
import type { ChatAdapter } from '../../../shared/chat-model';
import type { AgentStep, AgentUsage } from '../../agent/agent-loop';

/**
 * A node `inputs` expression: `main`, plus `{ type: 'ai_tool', displayName: 'Tools' }` while `condition`
 * (an expression body over `$parameter`) holds.
 */
export function vendorToolsInput(_condition: string): string {
  throw new Error('not implemented (L1)');
}

/**
 * Send `messages` (and `system`) to the model, run the connected tools up to `maxIterations` model calls,
 * and return the final text, the vendor's raw last reply (undefined when `model` is given), usage and
 * steps. Refuses before the first call when a connected tool can wait.
 */
export async function runVendorChat(
  _ctx: ExecuteContext,
  _itemIndex: number,
  _adapter: ChatAdapter,
  _options: { messages: AiChatMessage[]; system?: string; maxIterations: number; model?: AiChatModel },
): Promise<{ text: string; raw: unknown; usage: AgentUsage; steps: AgentStep[] }> {
  throw new Error('not implemented (L1)');
}
