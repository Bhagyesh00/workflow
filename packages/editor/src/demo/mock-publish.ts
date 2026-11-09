/**
 * Demo routes for publishing (P3-10) and the publish timeline (P3-16), registered by the
 * MockBackend constructor, as the server answers them: POST activate publishes a version (body
 * {versionId?, versionName?, description?}; default the current one; another workflow's version
 * 404) and stores the name and description on it, deactivate unpublishes, PATCH of a version names
 * or describes it (null clears). Every publish and unpublish records a timeline event; GET
 * /workflows/:id/publish-timeline answers from those events.
 */
import type { PublishBody, PublishTimelineEntry, VersionPatchBody } from '../api/types';
import { newId } from '../lib/ids';
import type { MockBackend, StoredWorkflow } from './mock-backend';
import { copy, HttpError, now } from './mock-http';

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
  const versionOf = (wf: StoredWorkflow, versionId: string) => {
    const version = backend.versions.find((v) => v.workflowId === wf.id && v.versionId === versionId);
    if (!version) throw new HttpError(404, 'not_found', 'Version not found');
    return version;
  };
  backend.on('POST', '/workflows/:id/activate', ({ params, body }) => {
    const wf = backend.workflow(params[0]);
    backend.requireScope('workflow:publish', { scopes: backend.rowScopes(wf) });
    const input = (body ?? {}) as PublishBody;
    const versionId = input.versionId ?? wf.versionId;
    const version = versionOf(wf, versionId);
    // the published graph is the version's; settings stay live on the workflow
    backend.validateForActivation({
      ...wf,
      nodes: version.snapshot.nodes,
      connections: version.snapshot.connections,
    });
    wf.active = true;
    wf.publishedVersionId = versionId;
    if (input.versionName !== undefined) version.versionName = input.versionName;
    if (input.description !== undefined) version.description = input.description;
    recordPublishEvent(backend, wf, 'activated', versionId);
    return backend.toDto(wf);
  });
  backend.on('POST', '/workflows/:id/deactivate', ({ params }) => {
    const wf = backend.workflow(params[0]);
    backend.requireScope('workflow:unpublish', { scopes: backend.rowScopes(wf) });
    const was = wf.publishedVersionId;
    wf.active = false;
    wf.publishedVersionId = null;
    if (was) recordPublishEvent(backend, wf, 'deactivated', was);
    return backend.toDto(wf);
  });
  backend.on('PATCH', '/workflows/:id/versions/:versionId', ({ params, body }) => {
    const wf = backend.workflow(params[0]);
    backend.requireScope('workflow:update', { scopes: backend.rowScopes(wf) });
    const version = versionOf(wf, params[1]);
    const patch = (body ?? {}) as VersionPatchBody;
    if (patch.versionName === undefined && patch.description === undefined)
      throw new HttpError(400, 'bad_request', 'Give versionName or description');
    if (patch.versionName !== undefined) version.versionName = patch.versionName?.trim() || null;
    if (patch.description !== undefined) version.description = patch.description;
    return {
      versionId: version.versionId,
      createdAt: version.createdAt,
      versionName: version.versionName ?? null,
      description: version.description ?? null,
      autosaved: version.autosaved ?? false,
      ...copy(version.snapshot),
    };
  });
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
