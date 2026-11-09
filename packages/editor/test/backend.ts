import { MockBackend } from '../src/demo/mock-backend';

let current = new MockBackend();

/** The mock server behind MSW for the current test (fresh before each test). */
export function backend(): MockBackend {
  return current;
}

export function resetBackend(): MockBackend {
  current = new MockBackend();
  return current;
}

/**
 * P6-39: makes `userId` a member of the signed-in workspace, as the server's `memberAs`: `editor` and `viewer`
 * (the old test names) are a `member` holding that project role on the workspace's oldest team project; any
 * other role is the workspace role.
 */
export function addMembership(userId: string, role: string): void {
  const tenantId = current.session!.tenantId;
  const projectRole = role === 'editor' || role === 'viewer' ? `project:${role}` : undefined;
  current.memberships.push({ tenantId, userId, role: projectRole ? 'member' : role });
  if (projectRole) {
    const team = current.oldestTeamProject(tenantId);
    current.projectRelations.push({ tenantId, projectId: team.id, userId, role: projectRole });
  }
}

/** A signed-in owner in a fresh workspace. */
export function signedIn(): MockBackend {
  current.createAccount({
    email: 'owner@example.com',
    password: 'secret-pass-1',
    name: 'Olive Owner',
    workspaceName: 'Test Space',
  });
  current.signIn('owner@example.com');
  return current;
}
