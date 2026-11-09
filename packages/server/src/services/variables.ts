/**
 * Variables by project (P6-31, L10): global variables (`variable:*`, global scopes) and project
 * variables (`projectVariable:*` on the project); in a run the project's value wins
 * (`repos.variables.map`). Texts as n8n: "A global variable with key ... already exists", "A variable
 * with key ... already exists in the specified project", "You are not allowed to create a variable in this
 * project". `ctx.variables`; the routes stay in routes/resources.ts (L10). C0 stub: the constructor is
 * real, every method throws until L10.
 */
import type { ServiceDeps } from '../context';
import type { VariableRow } from '../db/schema';
import type { AuthContext } from '../http/auth';

const notImplemented = (): never => {
  throw new Error('not implemented (L10)');
};

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

export class VariableService {
  constructor(readonly deps: ServiceDeps) {}

  async list(_auth: AuthContext, _options: VariableListOptions = {}): Promise<VariableRow[]> {
    return notImplemented();
  }

  async get(_auth: AuthContext, _id: string): Promise<VariableRow> {
    return notImplemented();
  }

  async create(_auth: AuthContext, _input: VariableCreateInput): Promise<VariableRow> {
    return notImplemented();
  }

  async update(_auth: AuthContext, _id: string, _patch: VariableUpdateInput): Promise<VariableRow> {
    return notImplemented();
  }

  async delete(_auth: AuthContext, _id: string): Promise<void> {
    notImplemented();
  }
}
