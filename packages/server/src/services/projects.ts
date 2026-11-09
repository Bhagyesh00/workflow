/**
 * Projects (P6-03, L1): n8n's `/rest/projects`. C0 stub: the constructor is real (createContext builds it
 * in every server test), every method throws until L1 fills it. The route gates live in
 * routes/projects.ts (`requireScope`); this service re-checks what a route cannot (personal project
 * rules, member roles, the team project limit `PlanLimits.maxTeamProjects`, transfer targets).
 */
import type { ServiceDeps } from '../context';
import type { ProjectIcon } from '../db/schema';
import type { AuthContext } from '../http/auth';

const notImplemented = (): never => {
  throw new Error('not implemented (L1)');
};

/** GET /projects: a bare array, or `{ count, data }` when `take` or `skip` is given */
export interface ProjectListQuery {
  take?: number;
  skip?: number;
}

/** POST /projects (`project:create`); the caller becomes `project:admin` */
export interface ProjectCreateInput {
  name: string;
  icon?: ProjectIcon | null;
  description?: string | null;
}

/** PATCH /projects/:projectId (`project:update`) */
export interface ProjectUpdateInput {
  name?: string;
  icon?: ProjectIcon | null;
  description?: string | null;
}

/** one member of POST /projects/:projectId/users: a project role slug, system or custom */
export interface ProjectRelationInput {
  userId: string;
  role: string;
}

/** DELETE /projects/:projectId?transferId=: move the work to `transferId`, else delete it */
export interface ProjectDeleteOptions {
  transferId?: string;
}

export class ProjectService {
  constructor(readonly deps: ServiceDeps) {}

  /** the projects the caller can see (team projects they relate to, all for `project:list` holders) */
  async list(_auth: AuthContext, _query: ProjectListQuery = {}): Promise<unknown> {
    return notImplemented();
  }

  /** counts by type (personal, team) */
  async count(_auth: AuthContext): Promise<unknown> {
    return notImplemented();
  }

  /** `user:list`: the projects a resource can be shared with, peers' personal projects included */
  async sharingCandidates(_auth: AuthContext): Promise<unknown> {
    return notImplemented();
  }

  async create(_auth: AuthContext, _input: ProjectCreateInput): Promise<unknown> {
    return notImplemented();
  }

  /** the caller's own projects, each with the caller's role and scopes */
  async myProjects(_auth: AuthContext): Promise<unknown> {
    return notImplemented();
  }

  /** the caller's personal project with its scopes */
  async personal(_auth: AuthContext): Promise<unknown> {
    return notImplemented();
  }

  /** one project with its relations, implicit members and the caller's scopes */
  async get(_auth: AuthContext, _projectId: string): Promise<unknown> {
    return notImplemented();
  }

  async update(_auth: AuthContext, _projectId: string, _patch: ProjectUpdateInput): Promise<unknown> {
    return notImplemented();
  }

  /** 201 with `conflicts`, 409 when none was added, 200 when nothing to do (the route sets the status) */
  async addUsers(
    _auth: AuthContext,
    _projectId: string,
    _relations: ProjectRelationInput[],
  ): Promise<unknown> {
    return notImplemented();
  }

  async changeUserRole(
    _auth: AuthContext,
    _projectId: string,
    _userId: string,
    _role: string,
  ): Promise<void> {
    notImplemented();
  }

  async removeUser(_auth: AuthContext, _projectId: string, _userId: string): Promise<void> {
    notImplemented();
  }

  /** a team project only; moves its work through `repos.projects.moveResources` or deletes it */
  async delete(_auth: AuthContext, _projectId: string, _options: ProjectDeleteOptions = {}): Promise<void> {
    notImplemented();
  }
}
