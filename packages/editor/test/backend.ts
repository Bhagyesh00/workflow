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
