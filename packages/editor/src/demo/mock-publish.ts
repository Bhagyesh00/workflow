/**
 * Demo routes for publishing (P3-10) and the publish timeline (P3-16), registered by the
 * MockBackend constructor.
 *
 * C0: activate / deactivate are the MockBackend's earlier handlers, moved here unchanged except that
 * they keep the published pointer (publishedVersionId) and record timeline events; GET
 * /workflows/:id/publish-timeline answers from those events. Lane L10 rewrites publishing (body,
 * version, review gate) and must keep the timeline recording and route; PATCH of a version answers
 * 501 until L10 writes it.
 */
import type { PublishTimelineEntry } from '../api/types';
import { newId } from '../lib/ids';
import type { MockBackend, StoredWorkflow } from './mock-backend';
import { notImplemented, now } from './mock-http';

export interface StoredPublishEvent extends PublishTimelineEntry {
  tenantId: string;
  workflowId: string;
}

/** the publish timeline rows of every workflow (newest last) */
export function publishEvents(backend: MockBackend): StoredPublishEvent[] {
  backend.ext.publishEvents ??= [];
  return backend.ext.publishEvents as StoredPublishEvent[];
}

export function recordPublishEvent(
  backend: MockBackend,
  wf: StoredWorkflow,
  event: 'activated' | 'deactivated',
  versionId: string | null,
): void {
  const user = backend.session ? backend.users.find((u) => u.id === backend.session!.userId) : undefined;
  publishEvents(backend).push({
    id: newId(),
    tenantId: wf.tenantId,
    workflowId: wf.id,
    event,
    versionId,
    versionName: null,
    userId: user?.id ?? null,
    userName: user?.name ?? null,
    createdAt: now(),
  });
}

export function registerPublishRoutes(backend: MockBackend): void {
  backend.on('POST', '/workflows/:id/activate', ({ params }) => {
    const wf = backend.workflow(params[0]);
    backend.validateForActivation(wf);
    wf.active = true;
    wf.publishedVersionId = wf.versionId;
    recordPublishEvent(backend, wf, 'activated', wf.versionId);
    return backend.toDto(wf);
  });
  backend.on('POST', '/workflows/:id/deactivate', ({ params }) => {
    const wf = backend.workflow(params[0]);
    const was = wf.publishedVersionId;
    wf.active = false;
    wf.publishedVersionId = null;
    if (was) recordPublishEvent(backend, wf, 'deactivated', was);
    return backend.toDto(wf);
  });
  backend.on('PATCH', '/workflows/:id/versions/:versionId', () => notImplemented('L10'));
  backend.on('GET', '/workflows/:id/publish-timeline', ({ params, query }) => {
    const wf = backend.workflow(params[0]);
    const skip = Math.max(Number(query.skip) || 0, 0);
    const take = Math.min(Math.max(Number(query.take) || 20, 1), 100);
    return publishEvents(backend)
      .filter((e) => e.workflowId === wf.id && e.tenantId === wf.tenantId)
      .reverse()
      .slice(skip, skip + take)
      .map(({ tenantId: _t, workflowId: _w, ...entry }) => {
        const version = entry.versionId
          ? backend.versions.find((v) => v.workflowId === wf.id && v.versionId === entry.versionId)
          : undefined;
        // a pruned version: no id, the row shows "Published a version"
        return {
          ...entry,
          versionId: entry.versionId && version ? entry.versionId : null,
          versionName: version?.versionName ?? null,
        };
      });
  });
}
