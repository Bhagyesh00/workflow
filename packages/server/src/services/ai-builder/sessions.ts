/**
 * Builder sessions on `workflow_builder_sessions` (P5-09, L1; the session routes are L6's). Every
 * query names tenant, workflow and user (`ctx.repos.builderSessions`).
 */
import type { BuilderMessage } from '@workflow/workflow';
import type { ServerContext } from '../../context';
import type { BuilderSession, BuilderSessionKey } from './types';

/** the stored session, or an empty one (no row written) when this user has none for this workflow */
export async function loadSession(_ctx: ServerContext, _key: BuilderSessionKey): Promise<BuilderSession> {
  throw new Error('not implemented (L1)');
}

/**
 * Writes the turn: `session` as the seams left it plus `messages` (the user's message, `text` already
 * through `redactSecrets`, and the assistant's reply with its `plan` or `questions`) appended.
 * Returns the saved session.
 */
export async function saveTurn(
  _ctx: ServerContext,
  _session: BuilderSession,
  _messages: BuilderMessage[],
): Promise<BuilderSession> {
  throw new Error('not implemented (L1)');
}
