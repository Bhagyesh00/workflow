/**
 * Variables by project (P6-31, L10): global variables (`variable:*`, global scopes) and project
 * variables (`projectVariable:*` on the project); in a run the project's value wins
 * (`repos.variables.map`). Texts as n8n: "A global variable with key ... already exists", "A variable
 * with key ... already exists in the specified project", "You are not allowed to create a variable in this
 * project". `ctx.variables`; the routes stay in routes/resources.ts. The route gates the first look; every
 * method here checks again on the row's own place (global scopes for a global variable, the project's
 * scopes for a project variable), so a caller other than the routes cannot skip it.
 */
import type { Scope } from '@workflow/workflow';
import { and, eq } from 'drizzle-orm';
import type { ServiceDeps } from '../context';
import { type VariableRow, variables } from '../db/schema';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import { isUniqueViolation } from '../repositories';
import { MISSING_SCOPE_MESSAGE } from './access';
import { assertTenantWritable } from './protected';

export interface VariableListOptions {
  /** a project's variables; `null` = global only; absent = every variable the caller may read */
  projectId?: string | null;
}

export interface VariableCreateInput {
  key: string;
  value: string;
  /** absent or null = a global variable */
  projectId?: string | null;
}

export interface VariableUpdateInput {
  key?: string;
  value?: string;
  /** moving between global and a project, or to another project */
  projectId?: string | null;
}

type Operation = 'create' | 'read' | 'update' | 'delete' | 'list';

function missingScope(): ApiError {
  return new ApiError(403, 'forbidden', MISSING_SCOPE_MESSAGE);
}

const scopeFor = (projectId: string | null, operation: Operation): Scope =>
  `${projectId === null ? 'variable' : 'projectVariable'}:${operation}` as Scope;

export class VariableService {
  constructor(readonly deps: ServiceDeps) {}

  private get repos() {
    return this.deps.repos;
  }

  private get access() {
    return this.deps.context().access;
  }

  /** the caller holds the operation's scope on the place (global, or one project); a missing project is 404 */
  private async allowed(auth: AuthContext, projectId: string | null, operation: Operation): Promise<boolean> {
    const held =
      projectId === null
        ? await this.access.scopesForAuth(auth)
        : await this.access.scopesForAuth(auth, { projectId });
    return held.has(scopeFor(projectId, operation));
  }

  private async require(auth: AuthContext, id: string): Promise<VariableRow> {
    const row = await this.repos.variables.get(auth.tenant.id, id);
    if (!row) throw ApiError.notFound('Variable');
    return row;
  }

  private duplicate(key: string, projectId: string | null): ApiError {
    return ApiError.conflict(
      projectId === null
        ? `A global variable with key "${key}" already exists`
        : `A variable with key "${key}" already exists in the specified project`,
    );
  }

  /** keys are unique among the global variables and among one project's variables (not across the two) */
  private async assertKeyFree(
    tenantId: string,
    key: string,
    projectId: string | null,
    exceptId?: string,
  ): Promise<void> {
    const rows = await this.repos.variables.list(tenantId, { projectId });
    if (rows.some((row) => row.key === key && row.id !== exceptId)) throw this.duplicate(key, projectId);
  }

  async list(auth: AuthContext, options: VariableListOptions = {}): Promise<VariableRow[]> {
    const tenantId = auth.tenant.id;
    const { projectId } = options;
    if (projectId !== undefined) {
      if (!(await this.allowed(auth, projectId, 'list'))) throw missingScope();
      return this.repos.variables.list(tenantId, { projectId });
    }
    // everything the caller may read: the globals with `variable:list`, the projects they list variables in
    const globals = await this.allowed(auth, null, 'list');
    const filter = await this.access.listFilter(auth, 'projectVariable:list');
    const rows = await this.repos.variables.list(tenantId, { filter });
    return rows.filter((row) => row.projectId !== null || globals);
  }

  async get(auth: AuthContext, id: string): Promise<VariableRow> {
    const row = await this.require(auth, id);
    if (!(await this.allowed(auth, row.projectId, 'read'))) throw missingScope();
    return row;
  }

  async create(auth: AuthContext, input: VariableCreateInput): Promise<VariableRow> {
    await assertTenantWritable(this.deps, auth.tenant.id, 'variableCreate');
    const tenantId = auth.tenant.id;
    const projectId = input.projectId ?? null;
    if (!(await this.allowed(auth, projectId, 'create'))) {
      throw projectId === null
        ? missingScope()
        : ApiError.forbidden('You are not allowed to create a variable in this project');
    }
    await this.assertKeyFree(tenantId, input.key, projectId);
    let created: VariableRow;
    try {
      created = await this.repos.variables.create(tenantId, {
        key: input.key,
        value: input.value,
        projectId,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw this.duplicate(input.key, projectId);
      throw error;
    }
    await this.audit(auth, 'variable.created', created);
    return created;
  }

  async update(auth: AuthContext, id: string, patch: VariableUpdateInput): Promise<VariableRow> {
    const tenantId = auth.tenant.id;
    const row = await this.require(auth, id);
    if (!(await this.allowed(auth, row.projectId, 'update'))) throw missingScope();
    const destination = patch.projectId === undefined ? row.projectId : patch.projectId;
    const key = patch.key ?? row.key;
    // a value change stays allowed on a protected workspace; a key rename does not (decisions H)
    if (key !== row.key) await assertTenantWritable(this.deps, tenantId, 'variableRename');
    // a move deletes the variable at one place and makes it at another, both refused there
    if (destination !== row.projectId) await assertTenantWritable(this.deps, tenantId, 'variableMove');
    if (destination !== row.projectId) {
      // moving needs the right to make a variable at the other place
      if (!(await this.allowed(auth, destination, 'create'))) {
        throw destination === null
          ? missingScope()
          : ApiError.forbidden('You are not allowed to create a variable in this project');
      }
    }
    if (destination !== row.projectId || key !== row.key) {
      await this.assertKeyFree(tenantId, key, destination, row.id);
    }
    try {
      // the repository's update leaves the place alone; a move is the one write made here
      const updated =
        destination !== row.projectId
          ? (
              await this.deps.database.db
                .update(variables)
                .set({
                  projectId: destination,
                  ...(patch.key !== undefined ? { key: patch.key } : {}),
                  ...(patch.value !== undefined ? { value: patch.value } : {}),
                  updatedAt: new Date(),
                })
                .where(and(eq(variables.tenantId, tenantId), eq(variables.id, id)))
                .returning()
            )[0]
          : await this.repos.variables.update(tenantId, id, {
              ...(patch.key !== undefined ? { key: patch.key } : {}),
              ...(patch.value !== undefined ? { value: patch.value } : {}),
            });
      if (!updated) throw ApiError.notFound('Variable');
      await this.audit(auth, 'variable.updated', updated);
      return updated;
    } catch (error) {
      if (isUniqueViolation(error)) throw this.duplicate(key, destination);
      throw error;
    }
  }

  async delete(auth: AuthContext, id: string): Promise<void> {
    await assertTenantWritable(this.deps, auth.tenant.id, 'variableDelete');
    const row = await this.require(auth, id);
    if (!(await this.allowed(auth, row.projectId, 'delete'))) throw missingScope();
    if (!(await this.repos.variables.delete(auth.tenant.id, id))) throw ApiError.notFound('Variable');
    await this.audit(auth, 'variable.deleted', row);
  }

  /** P6-58: the audit row of a variable write; the key and the place, never the value */
  private async audit(auth: AuthContext, action: string, row: VariableRow): Promise<void> {
    await this.repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action,
      resourceType: 'variable',
      resourceId: row.id,
      metadata: { key: row.key, ...(row.projectId ? { projectId: row.projectId } : {}) },
    });
  }
}
