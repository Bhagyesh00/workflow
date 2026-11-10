/**
 * P6-19: the demo's password reset, email change and profile: forgot and reset password, the reset link of
 * a member, the account's name, password and email. The demo has no mailbox, so every "mail" lands in
 * `demoMailbox(backend)` (tests and the demo spec read the link there). Tokens last 20 minutes and work once;
 * the texts and codes match the server's (routes/password.ts, services/password.ts).
 */
import type { MockBackend } from './mock-backend';
import { HttpError } from './mock-http';

const TOKEN_MS = 20 * 60_000;

export interface DemoMail {
  to: string;
  kind: 'passwordReset' | 'emailChangeRequested' | 'emailChangeCompleted';
  /** the link in the mail (none in the completed mail) */
  link?: string;
}

interface DemoToken {
  kind: 'password_reset' | 'email_change';
  userId: string;
  email?: string;
  expiresAt: number;
}

interface State {
  tokens: Map<string, DemoToken>;
  mail: DemoMail[];
}

const states = new WeakMap<MockBackend, State>();

function stateOf(backend: MockBackend): State {
  let state = states.get(backend);
  if (!state) {
    state = { tokens: new Map(), mail: [] };
    states.set(backend, state);
  }
  return state;
}

/** the mails the demo would have sent, oldest first */
export function demoMailbox(backend: MockBackend): readonly DemoMail[] {
  return stateOf(backend).mail;
}

const origin = (): string => globalThis.location?.origin ?? 'http://localhost:5678';

function newToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** the same rule as the server's `passwordProblem` */
function passwordProblem(password: string): string | undefined {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return 'Password must contain at least one letter and one digit';
  }
  return undefined;
}

const INVALID_LINK = 'This link is invalid or has expired. Request a new one.';

export function registerPasswordRoutes(backend: MockBackend): void {
  const state = stateOf(backend);

  const issue = (userId: string, kind: DemoToken['kind'], email?: string): string => {
    for (const [token, row] of state.tokens) {
      if (row.userId === userId && row.kind === kind) state.tokens.delete(token);
    }
    const token = newToken();
    state.tokens.set(token, { kind, userId, email, expiresAt: Date.now() + TOKEN_MS });
    return token;
  };
  const pending = (token: string | undefined, kind: DemoToken['kind']): DemoToken | undefined => {
    const row = token ? state.tokens.get(token) : undefined;
    return row && row.kind === kind && row.expiresAt > Date.now() ? row : undefined;
  };
  const mfaProblem = (userId: string, code: string | undefined): void => {
    if (!backend.mfaEnabledUsers.has(userId)) return;
    if (!code) throw new HttpError(400, 'bad_request', 'If MFA enabled, mfaCode is required.');
    if (!backend.mfaCheck(userId, code, undefined) && !backend.mfaCheck(userId, undefined, code)) {
      throw new HttpError(400, 'invalid_mfa', 'Invalid MFA token.');
    }
  };

  backend.on('POST', '/auth/forgot-password', ({ body }) => {
    const email = (text(body.email) ?? '').trim().toLowerCase();
    if (!email) throw new HttpError(400, 'validation_error', 'Request validation failed');
    const user = backend.users.find((u) => u.email.toLowerCase() === email);
    if (user) {
      const token = issue(user.id, 'password_reset');
      state.mail.push({
        to: user.email,
        kind: 'passwordReset',
        link: `${origin()}/reset-password?token=${token}`,
      });
    }
    return { ok: true };
  });

  backend.on('POST', '/auth/reset-token/resolve', ({ body }) => {
    const row = pending(text(body.token), 'password_reset');
    if (!row) throw new HttpError(400, 'bad_request', INVALID_LINK);
    return { mfaEnabled: backend.mfaEnabledUsers.has(row.userId) };
  });

  backend.on('POST', '/auth/reset-password', ({ body }) => {
    const token = text(body.token);
    const password = typeof body.password === 'string' ? body.password : '';
    const problem = passwordProblem(password);
    if (problem) throw new HttpError(400, 'bad_request', problem);
    const row = pending(token, 'password_reset');
    const user = row && backend.users.find((u) => u.id === row.userId);
    if (!row || !user || !token) throw new HttpError(400, 'bad_request', INVALID_LINK);
    mfaProblem(user.id, text(body.mfaCode));
    state.tokens.delete(token);
    user.password = password;
    if (backend.session?.userId === user.id) backend.session = null;
    return { ok: true };
  });

  backend.on('POST', '/auth/confirm-email-change', ({ body }) => {
    const token = text(body.token);
    const row = pending(token, 'email_change');
    const user = row && backend.users.find((u) => u.id === row.userId);
    if (!row || !user || !row.email || !token) throw new HttpError(400, 'bad_request', INVALID_LINK);
    if (backend.users.some((u) => u.id !== user.id && u.email.toLowerCase() === row.email)) {
      throw new HttpError(409, 'conflict', 'This email address is already in use');
    }
    state.tokens.delete(token);
    const old = user.email;
    user.email = row.email;
    state.mail.push({ to: old, kind: 'emailChangeCompleted' });
    return { ok: true };
  });

  backend.on('PATCH', '/auth/me', ({ body }) => {
    const { user } = backend.auth();
    const name = text(body.name)?.trim();
    if (!name) throw new HttpError(400, 'validation_error', 'Request validation failed');
    user.name = name;
    return { id: user.id, email: user.email, name: user.name };
  });

  backend.on('PATCH', '/auth/me/password', ({ body }) => {
    const { user } = backend.auth();
    const next = typeof body.newPassword === 'string' ? body.newPassword : '';
    const problem = passwordProblem(next);
    if (problem) throw new HttpError(400, 'bad_request', problem);
    if (body.currentPassword !== user.password) {
      throw new HttpError(400, 'invalid_password', 'The current password is not correct');
    }
    mfaProblem(user.id, text(body.mfaCode));
    user.password = next;
    return { ok: true };
  });

  backend.on('POST', '/auth/change-email', ({ body }) => {
    const { user } = backend.auth();
    const email = (text(body.email) ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new HttpError(400, 'validation_error', 'Request validation failed');
    }
    if (email === user.email.toLowerCase()) {
      throw new HttpError(400, 'bad_request', 'The new email address matches the current one');
    }
    if (backend.mfaEnabledUsers.has(user.id)) {
      const code = text(body.mfaCode);
      if (!code) throw new HttpError(400, 'bad_request', 'Two-factor code is required to change email');
      if (!backend.mfaCheck(user.id, code, undefined)) {
        throw new HttpError(400, 'invalid_mfa', 'Invalid MFA token.');
      }
    } else {
      if (!text(body.currentPassword)) {
        throw new HttpError(400, 'bad_request', 'Current password is required to change email');
      }
      if (body.currentPassword !== user.password) {
        throw new HttpError(400, 'invalid_password', 'The current password is not correct');
      }
    }
    if (backend.users.some((u) => u.email.toLowerCase() === email)) {
      throw new HttpError(409, 'conflict', 'This email address is already in use');
    }
    const token = issue(user.id, 'email_change', email);
    state.mail.push({
      to: email,
      kind: 'emailChangeRequested',
      link: `${origin()}/confirm-email-change?token=${token}`,
    });
    return { ok: true };
  });

  backend.on('GET', '/members/:userId/password-reset-link', ({ params }) => {
    const { tenant } = backend.requireScope('user:resetPassword');
    const userId = params[0];
    const membership = backend.memberships.find((m) => m.tenantId === tenant.id && m.userId === userId);
    const user = membership && backend.users.find((u) => u.id === userId);
    if (!membership || !user || membership.status === 'disabled' || membership.status === 'pending') {
      throw new HttpError(404, 'not_found', 'Member not found');
    }
    if (membership.role === 'owner') {
      throw new HttpError(
        403,
        'forbidden',
        "An owner's password cannot be reset by a link from the members list",
      );
    }
    const token = issue(user.id, 'password_reset');
    return { link: `${origin()}/reset-password?token=${token}` };
  });
}
