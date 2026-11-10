/**
 * P6-02 (L13): SCIM 2.0 users, per decisions B: the workspace comes from the token only; filters
 * `userName eq` and `externalId eq`; PATCH in the Entra and Okta shapes; create links or makes a user
 * managed by this workspace; `active:false` disables the member (`disableMember`), `active:true` enables it;
 * DELETE disables or deletes per `tenants.settings.scim.onDelete`, the work moved or deleted per
 * `dataAction`. The owner cannot be touched; name and email change only for users this workspace manages.
 * No outbound call.
 */
import type { DataObject } from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import type { TenantRow } from '../db/schema';
import { ApiError } from '../http/errors';
import { createRepositories } from '../repositories';
import type { ScimMember } from '../repositories/scim';
import { disableMember, enableMember } from './member-disable';
import { transferPersonalWork } from './member-removal';
import { randomToken } from './auth';

/** a SCIM answer: the status and the `application/scim+json` body */
export interface ScimReply {
  status: number;
  body: DataObject;
}

export interface ScimListQuery {
  filter?: string;
  startIndex: number;
  count: number;
}

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

/** an error with the SCIM `scimType` (`uniqueness`, `invalidFilter`, `invalidValue`, `invalidSyntax`) */
export class ScimError extends ApiError {
  constructor(
    statusCode: number,
    message: string,
    readonly scimType?: string,
  ) {
    super(statusCode, scimType ?? 'scim_error', message);
  }
}

const MAX_COUNT = 1000;
const MAX_TEXT = 320;

export type ScimOnDelete = 'disable' | 'delete';
export type ScimDataAction = 'transfer' | 'delete';

export interface ScimSettings {
  enabled: boolean;
  onDelete: ScimOnDelete;
  dataAction: ScimDataAction;
  transferProjectId: string | null;
}

/** `tenants.settings.scim` with its defaults: off, disable on delete, transfer the work */
export function scimSettingsOf(tenant: Pick<TenantRow, 'settings'>): ScimSettings {
  const raw = (tenant.settings as { scim?: Record<string, unknown> } | null)?.scim;
  const scim = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: scim.enabled === true,
    onDelete: scim.onDelete === 'delete' ? 'delete' : 'disable',
    dataAction: scim.dataAction === 'delete' ? 'delete' : 'transfer',
    transferProjectId: typeof scim.transferProjectId === 'string' ? scim.transferProjectId : null,
  };
}

/** what a request changes; a field that is absent stays as it is */
interface Changes {
  email?: string;
  givenName?: string;
  familyName?: string;
  displayName?: string;
  active?: boolean;
  externalId?: string | null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : undefined;
}

/** Entra sends booleans as the strings "True" and "False" */
function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return undefined;
}

function invalid(message: string): ScimError {
  return new ScimError(400, message, 'invalidValue');
}

function emailOf(value: string | undefined): string | undefined {
  const email = value?.trim().toLowerCase();
  return email && email.includes('@') && !/\s/.test(email) ? email : undefined;
}

/** the primary work address of an `emails` value, else the first one with a value */
function emailFromList(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
  const primary = items.find((item) => bool(item.primary) === true && text(item.value));
  const work = items.find((item) => String(item.type ?? '').toLowerCase() === 'work' && text(item.value));
  const any = items.find((item) => text(item.value));
  return emailOf(text((primary ?? work ?? any)?.value));
}

function splitName(name: string): { givenName: string; familyName: string } {
  const trimmed = name.trim();
  const at = trimmed.indexOf(' ');
  return at < 0
    ? { givenName: trimmed, familyName: '' }
    : { givenName: trimmed.slice(0, at), familyName: trimmed.slice(at + 1).trim() };
}

/** the whole object of a PUT, a POST or a path-less PATCH value, into `changes` */
function readObject(changes: Changes, body: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(body)) {
    const lowered = key.toLowerCase();
    if (lowered === 'roles' || lowered === 'schemas' || lowered === 'meta' || lowered === 'id') continue;
    readPath(changes, key, value);
  }
}

/** one attribute path with its value; an unknown path is ignored, as n8n does */
function readPath(changes: Changes, rawPath: string, value: unknown): void {
  const path = rawPath.trim();
  const lowered = path.toLowerCase();
  if (lowered === 'active') {
    const active = bool(value);
    if (active === undefined) throw invalid('active must be true or false');
    changes.active = active;
  } else if (lowered === 'username') {
    // a user name that is no address is ignored here: `emails` may hold the address
    const email = emailOf(text(value));
    if (email) changes.email = email;
  } else if (lowered === 'externalid') {
    changes.externalId = text(value) || null;
  } else if (lowered === 'displayname') {
    changes.displayName = text(value);
  } else if (lowered === 'name') {
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) readPath(changes, `name.${k}`, v);
    }
  } else if (lowered === 'name.givenname') {
    changes.givenName = text(value) ?? '';
  } else if (lowered === 'name.familyname') {
    changes.familyName = text(value) ?? '';
  } else if (lowered === 'name.formatted') {
    changes.displayName ??= text(value);
  } else if (lowered === 'emails') {
    const email = emailFromList(value);
    if (email) changes.email = email;
  } else if (/^emails\[.*\]\.value$/i.test(path) || lowered === 'emails.value') {
    const email = emailOf(text(value));
    if (email) changes.email = email;
  }
}

/** the member's name from the changes: a given or family part replaces its part, a display name the whole */
function nameFrom(current: string, changes: Changes, email: string): string | undefined {
  if (changes.givenName !== undefined || changes.familyName !== undefined) {
    const old = splitName(current);
    const name = `${changes.givenName ?? old.givenName} ${changes.familyName ?? old.familyName}`.trim();
    return name || undefined;
  }
  if (changes.displayName) return changes.displayName;
  return current ? undefined : email.split('@')[0];
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null)?.code;
  const cause = (error as { cause?: { code?: string } } | null)?.cause?.code;
  return code === '23505' || cause === '23505';
}

export class ScimService {
  constructor(readonly deps: ServiceDeps) {}

  private base(): string {
    return `${this.deps.config.baseUrl}/scim/v2`;
  }

  private resource(member: ScimMember): DataObject {
    const { givenName, familyName } = splitName(member.name);
    const resource: DataObject = {
      schemas: [SCIM_USER_SCHEMA],
      id: member.userId,
      userName: member.email,
      name: { givenName, familyName, formatted: member.name },
      displayName: member.name,
      emails: [{ value: member.email, type: 'work', primary: true }],
      active: member.disabledAt === null,
      meta: {
        resourceType: 'User',
        created: member.createdAt.toISOString(),
        location: `${this.base()}/Users/${member.userId}`,
      },
    };
    if (member.externalId) resource.externalId = member.externalId;
    return resource;
  }

  private notFound(id: string): ScimError {
    return new ScimError(404, `Resource ${id.slice(0, 64)} not found`);
  }

  private async member(tenant: TenantRow, id: string): Promise<ScimMember> {
    const member = await this.deps.repos.scim.getMember(tenant.id, id);
    if (!member) throw this.notFound(id);
    return member;
  }

  async listUsers(tenant: TenantRow, query: ScimListQuery): Promise<ScimReply> {
    let userName: string | undefined;
    let externalId: string | undefined;
    if (query.filter !== undefined && query.filter.trim() !== '') {
      const match = /^\s*(userName|externalId)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(query.filter);
      if (!match) {
        throw new ScimError(400, 'Only the filters userName eq "value" and externalId eq "value" work', 'invalidFilter');
      }
      const value = match[2].replace(/\\(.)/g, '$1');
      if (match[1].toLowerCase() === 'username') userName = value;
      else externalId = value;
    }
    const startIndex = Math.max(1, query.startIndex);
    const count = Math.min(Math.max(0, query.count), MAX_COUNT);
    const { total, rows } = await this.deps.repos.scim.listMembers(tenant.id, {
      userName,
      externalId,
      offset: startIndex - 1,
      limit: count,
    });
    return {
      status: 200,
      body: {
        schemas: [LIST_SCHEMA],
        totalResults: total,
        startIndex,
        itemsPerPage: rows.length,
        Resources: rows.map((row) => this.resource(row)),
      },
    };
  }

  async getUser(tenant: TenantRow, id: string): Promise<ScimReply> {
    return { status: 200, body: this.resource(await this.member(tenant, id)) };
  }

  async createUser(tenant: TenantRow, body: DataObject): Promise<ScimReply> {
    const changes: Changes = {};
    readObject(changes, body ?? {});
    // the email: the primary address of `emails`, else the user name
    const email = emailFromList(body?.emails) ?? changes.email;
    if (!email) {
      throw invalid(`Cannot determine an email address for ${text(body?.userName) ?? 'the user'}`);
    }
    const { repos } = this.deps;
    // every 409 comes before any write; an email that exists anywhere is a conflict (n8n)
    if (await repos.users.getByEmail(email)) {
      throw new ScimError(409, 'User with this userName already exists', 'uniqueness');
    }
    const externalId = changes.externalId ?? null;
    if (externalId && (await repos.memberships.getByExternalId(tenant.id, externalId))) {
      throw new ScimError(409, 'User with this externalId already exists', 'uniqueness');
    }
    const name = nameFrom('', changes, email) ?? email.split('@')[0];
    const ctx = this.deps.context();
    const method = await ctx.ssoSettings.activeMethod(tenant.id);
    const passwordHash = await ctx.auth.hashPassword(randomToken(32));
    let userId: string;
    try {
      userId = await this.deps.database.db.transaction(async (tx) => {
        const txRepos = createRepositories(tx);
        const user = await txRepos.users.create({ email, name, passwordHash });
        await txRepos.users.setManagedBy(user.id, tenant.id);
        await txRepos.memberships.add(tenant.id, user.id, 'member');
        await txRepos.projects.ensurePersonal(tenant.id, user);
        if (externalId) {
          await txRepos.memberships.setExternalId(tenant.id, user.id, externalId);
          if (method === 'saml' || method === 'oidc') {
            await txRepos.sso.linkIdentity(tenant.id, { providerType: method, providerId: externalId, userId: user.id });
          }
        }
        await txRepos.audit.add(tenant.id, {
          userId: null,
          action: 'scim.user_created',
          resourceType: 'user',
          resourceId: user.id,
        });
        return user.id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ScimError(409, 'User with this userName already exists', 'uniqueness');
      }
      throw error;
    }
    if (changes.active === false) await disableMember(ctx, tenant.id, userId, null);
    return { status: 201, body: this.resource(await this.member(tenant, userId)) };
  }

  async replaceUser(tenant: TenantRow, id: string, body: DataObject): Promise<ScimReply> {
    const changes: Changes = {};
    readObject(changes, body ?? {});
    const email = emailFromList(body?.emails) ?? changes.email;
    if (email) changes.email = email;
    return this.apply(tenant, id, changes);
  }

  async patchUser(tenant: TenantRow, id: string, body: DataObject): Promise<ScimReply> {
    const operations = body?.Operations;
    if (!Array.isArray(operations)) {
      throw new ScimError(400, 'A PATCH needs an Operations list', 'invalidSyntax');
    }
    const schemas = Array.isArray(body.schemas) ? body.schemas : [PATCH_SCHEMA];
    if (!schemas.length) throw new ScimError(400, 'A PATCH needs schemas', 'invalidSyntax');
    const changes: Changes = {};
    for (const raw of operations) {
      if (!raw || typeof raw !== 'object') throw new ScimError(400, 'An operation must be an object', 'invalidSyntax');
      const operation = raw as { op?: unknown; path?: unknown; value?: unknown };
      const op = String(operation.op ?? '').toLowerCase();
      if (op !== 'add' && op !== 'replace' && op !== 'remove') {
        throw new ScimError(400, `The operation "${text(String(operation.op ?? '')) ?? ''}" is not supported`, 'invalidSyntax');
      }
      const path = typeof operation.path === 'string' ? operation.path : undefined;
      if (op === 'remove') {
        // only the SCIM id can be cleared; the rest of a user is not removable
        if (path?.toLowerCase() === 'externalid') changes.externalId = null;
        continue;
      }
      if (path === undefined || path.trim() === '') {
        if (operation.value && typeof operation.value === 'object' && !Array.isArray(operation.value)) {
          readObject(changes, operation.value as Record<string, unknown>);
        }
      } else {
        readPath(changes, path, operation.value);
      }
    }
    return this.apply(tenant, id, changes);
  }

  /** the writes of a PUT or PATCH: the owner guard, the 409s, then the writes, only for what changed */
  private async apply(tenant: TenantRow, id: string, changes: Changes): Promise<ScimReply> {
    const member = await this.member(tenant, id);
    const { repos } = this.deps;
    const ctx = this.deps.context();
    const emailChanged = changes.email !== undefined && changes.email !== member.email.toLowerCase();
    if (member.role === 'owner' && (emailChanged || changes.active === false)) {
      throw new ScimError(403, "The workspace owner can't be changed or deactivated through SCIM");
    }
    // name and email change only for users this workspace made; the rest take `active` and `externalId`
    const managed = member.managedByTenantId === tenant.id;
    if (managed && emailChanged) {
      const other = await repos.users.getByEmail(changes.email as string);
      if (other && other.id !== member.userId) {
        throw new ScimError(409, 'User with this userName already exists', 'uniqueness');
      }
    }
    const externalChanged = changes.externalId !== undefined && changes.externalId !== member.externalId;
    if (externalChanged && changes.externalId) {
      const other = await repos.memberships.getByExternalId(tenant.id, changes.externalId);
      if (other && other.userId !== member.userId) {
        throw new ScimError(409, 'User with this externalId already exists', 'uniqueness');
      }
    }
    const newName = managed ? nameFrom(member.name, changes, member.email) : undefined;
    const nameChanged = newName !== undefined && newName !== member.name;
    const method = externalChanged ? await ctx.ssoSettings.activeMethod(tenant.id) : 'email';
    let wrote = false;
    try {
      await this.deps.database.db.transaction(async (tx) => {
        const txRepos = createRepositories(tx);
        if (managed && emailChanged) {
          await txRepos.users.updateEmail(member.userId, changes.email as string);
          wrote = true;
        }
        if (nameChanged) {
          await txRepos.users.updateName(member.userId, newName as string);
          wrote = true;
        }
        if (externalChanged) {
          await txRepos.memberships.setExternalId(tenant.id, member.userId, changes.externalId ?? null);
          if (changes.externalId && (method === 'saml' || method === 'oidc')) {
            await txRepos.sso.linkIdentity(tenant.id, {
              providerType: method,
              providerId: changes.externalId,
              userId: member.userId,
            });
          }
          wrote = true;
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ScimError(409, 'User with this userName already exists', 'uniqueness');
      }
      throw error;
    }
    if (changes.active === false && member.disabledAt === null) {
      wrote = (await disableMember(ctx, tenant.id, member.userId, null)) || wrote;
    } else if (changes.active === true && member.disabledAt !== null) {
      wrote = (await enableMember(ctx, tenant.id, member.userId, null)) || wrote;
    }
    if (wrote) {
      await repos.audit.add(tenant.id, {
        userId: null,
        action: 'scim.user_updated',
        resourceType: 'user',
        resourceId: member.userId,
      });
    }
    return { status: 200, body: this.resource(await this.member(tenant, id)) };
  }

  async deleteUser(tenant: TenantRow, id: string): Promise<ScimReply> {
    const member = await this.member(tenant, id);
    if (member.role === 'owner') {
      throw new ScimError(403, "The workspace owner can't be changed or deactivated through SCIM");
    }
    const ctx = this.deps.context();
    const policy = scimSettingsOf(tenant);
    // an admin is only deactivated, whatever the policy says
    if (policy.onDelete === 'disable' || member.role === 'admin') {
      await disableMember(ctx, tenant.id, member.userId, null);
      await this.deps.repos.audit.add(tenant.id, {
        userId: null,
        action: 'scim.user_deleted',
        resourceType: 'user',
        resourceId: member.userId,
        metadata: { result: 'disabled' },
      });
      return { status: 204, body: {} };
    }
    // the ways in end first, so nothing new is saved while the work moves
    await disableMember(ctx, tenant.id, member.userId, null);
    const target = policy.dataAction === 'transfer' ? await this.transferTarget(tenant, member.userId) : null;
    await transferPersonalWork(ctx, tenant.id, member.userId, target);
    await this.deps.database.db.transaction(async (tx) => {
      const txRepos = createRepositories(tx);
      await txRepos.sessions.deleteForUserInTenant(tenant.id, member.userId);
      await txRepos.apiKeys.deleteAllForUser(tenant.id, member.userId);
      await txRepos.mcpOAuth.deleteTokensForUser(tenant.id, member.userId);
      await txRepos.memberships.remove(tenant.id, member.userId);
      // the account goes only when this workspace made it and no other workspace has the person
      if (
        member.managedByTenantId === tenant.id &&
        (await txRepos.sso.otherMembershipCount(member.userId, tenant.id)) === 0
      ) {
        await txRepos.scim.deleteUser(member.userId);
      }
      await txRepos.audit.add(tenant.id, {
        userId: null,
        action: 'scim.user_deleted',
        resourceType: 'user',
        resourceId: member.userId,
        metadata: { result: 'deleted', dataAction: policy.dataAction },
      });
    });
    await ctx.privateCredentials.afterAccessChange(tenant.id, { userId: member.userId });
    return { status: 204, body: {} };
  }

  /**
   * The project that receives a removed user's work: the stored target while it is still a team project or the
   * personal project of an active member (and not the user's own), else the owner's personal project.
   */
  private async transferTarget(tenant: TenantRow, userId: string): Promise<string | null> {
    const { repos } = this.deps;
    const stored = scimSettingsOf(tenant).transferProjectId;
    const own = await repos.projects.getPersonal(tenant.id, userId);
    if (stored) {
      const project = await repos.projects.get(tenant.id, stored);
      if (project && project.id !== own?.id) {
        if (project.type === 'team') return project.id;
        if (project.ownerUserId && (await repos.memberships.get(tenant.id, project.ownerUserId))) {
          return project.id;
        }
      }
    }
    const ownerId = await repos.scim.firstOwner(tenant.id);
    const home = ownerId ? await repos.projects.getPersonal(tenant.id, ownerId) : undefined;
    return home && home.id !== own?.id ? home.id : null;
  }

  /** `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` */
  discovery(kind: 'serviceProviderConfig' | 'resourceTypes' | 'schemas'): DataObject {
    if (kind === 'serviceProviderConfig') {
      return {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: MAX_COUNT },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
        authenticationSchemes: [
          {
            type: 'oauthbearertoken',
            name: 'OAuth Bearer Token',
            description: 'Authentication with the workspace SCIM token',
            primary: true,
          },
        ],
        meta: { resourceType: 'ServiceProviderConfig', location: `${this.base()}/ServiceProviderConfig` },
      };
    }
    if (kind === 'resourceTypes') {
      return {
        schemas: [LIST_SCHEMA],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        Resources: [
          {
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
            id: 'User',
            name: 'User',
            endpoint: '/Users',
            description: 'User account',
            schema: SCIM_USER_SCHEMA,
            meta: { resourceType: 'ResourceType', location: `${this.base()}/ResourceTypes/User` },
          },
        ],
      };
    }
    const attribute = (name: string, extra: Record<string, unknown> = {}) => ({
      name,
      type: 'string',
      multiValued: false,
      required: false,
      caseExact: false,
      mutability: 'readWrite',
      returned: 'default',
      uniqueness: 'none',
      ...extra,
    });
    return {
      schemas: [LIST_SCHEMA],
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 1,
      Resources: [
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
          id: SCIM_USER_SCHEMA,
          name: 'User',
          description: 'User account',
          attributes: [
            attribute('userName', { required: true, uniqueness: 'server' }),
            attribute('externalId', { caseExact: true }),
            attribute('displayName'),
            attribute('name', {
              type: 'complex',
              subAttributes: [attribute('givenName'), attribute('familyName'), attribute('formatted')],
            }),
            attribute('emails', {
              type: 'complex',
              multiValued: true,
              subAttributes: [
                attribute('value'),
                attribute('type'),
                attribute('primary', { type: 'boolean' }),
              ],
            }),
            attribute('active', { type: 'boolean' }),
          ],
          meta: { resourceType: 'Schema', location: `${this.base()}/Schemas/${SCIM_USER_SCHEMA}` },
        },
      ],
    };
  }
}
