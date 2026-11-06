import type { PyodideCodeRunner } from '@workflow/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestServer, signup, type TestServer } from './helpers';

describe('Python memory cap', () => {
  let server: TestServer;
  let tenantId: string;

  const built = async (target: TestServer) =>
    target.ctx.executions.buildServices({
      tenant: (await target.ctx.repos.tenants.get(tenantId))!,
      executionId: '',
      mode: 'manual',
    });

  beforeAll(async () => {
    server = await createTestServer({}, { startMain: false });
    tenantId = (await signup(server.app)).tenant.id;
  });
  afterAll(() => server.close());

  it('is 256 MB by default and leaves the JavaScript cap at CODE_MEMORY_MB', async () => {
    const services = await built(server);
    expect(server.ctx.config.code.memoryMb).toBe(128);
    expect((services.pythonRunner as PyodideCodeRunner).options.memoryLimitMb).toBe(256);
    expect(services.codeRunner).toMatchObject({ memoryLimitMb: 128 });
  });

  it('follows a higher CODE_MEMORY_MB', async () => {
    const higher = await createTestServer({ CODE_MEMORY_MB: '512' }, { startMain: false, reset: false });
    try {
      const services = await built(higher);
      expect((services.pythonRunner as PyodideCodeRunner).options.memoryLimitMb).toBe(512);
      expect(services.codeRunner).toMatchObject({ memoryLimitMb: 512 });
    } finally {
      await higher.close();
    }
  });
});
