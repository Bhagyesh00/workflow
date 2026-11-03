/**
 * Demo routes for annotation tags and PATCH /executions/:id (P3-09), registered by the MockBackend
 * constructor, plus the annotationTags / vote filter of GET /executions.
 *
 * They follow the server rules: a tag name is 1..24 characters and unique per workspace without
 * regard to case, tag ids must belong to the workspace (404), a viewer cannot write (403), and an
 * execution with no tag and no vote has no annotation (null). State lives in `backend.ext`; the
 * annotation sits on the stored execution as `execution.annotation`.
 */
import type { AnnotationTag } from '../api/types';
import { newId } from '../lib/ids';
import type { MockBackend, StoredExecution } from './mock-backend';
import { HttpError, now } from './mock-http';

interface StoredAnnotationTag extends AnnotationTag {
  tenantId: string;
}

function tagList(backend: MockBackend): StoredAnnotationTag[] {
  backend.ext.annotationTags ??= [] as StoredAnnotationTag[];
  return backend.ext.annotationTags as StoredAnnotationTag[];
}

const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);

function parseName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length < 1 || name.length > 24) {
    throw new HttpError(400, 'validation_error', 'The tag name must be 1 to 24 characters');
  }
  return name;
}

export function registerAnnotationRoutes(backend: MockBackend): void {
  const own = (tenantId: string) => tagList(backend).filter((t) => t.tenantId === tenantId);
  const usage = (tag: StoredAnnotationTag) =>
    backend.executions.filter(
      (e) => e.tenantId === tag.tenantId && e.annotation?.tags.some((t) => t.id === tag.id),
    ).length;
  const dto = (tag: StoredAnnotationTag, withUsageCount: boolean): AnnotationTag => ({
    id: tag.id,
    name: tag.name,
    createdAt: tag.createdAt,
    updatedAt: tag.updatedAt,
    ...(withUsageCount ? { usageCount: usage(tag) } : {}),
  });
  const duplicate = (tenantId: string, name: string, exceptId?: string) =>
    own(tenantId).some((t) => t.id !== exceptId && t.name.toLowerCase() === name.toLowerCase());
  const conflict = (name: string) =>
    new HttpError(409, 'conflict', `An annotation tag named "${name}" already exists`);
  const tagOf = (tenantId: string, id: string) => {
    const tag = own(tenantId).find((t) => t.id === id);
    if (!tag) throw notFound('Annotation tag');
    return tag;
  };
  const tidy = (e: StoredExecution) => {
    if (e.annotation && !e.annotation.vote && e.annotation.tags.length === 0) e.annotation = null;
  };

  backend.on('GET', '/annotation-tags', ({ query }) => {
    const { tenant } = backend.auth();
    const withCount = query.withUsageCount === 'true';
    return own(tenant.id)
      .slice()
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      .map((t) => dto(t, withCount));
  });

  backend.on('POST', '/annotation-tags', ({ body }) => {
    const { tenant } = backend.requireRole('editor');
    const name = parseName(body.name);
    if (duplicate(tenant.id, name)) throw conflict(name);
    const stamp = now();
    const tag: StoredAnnotationTag = {
      id: newId(),
      tenantId: tenant.id,
      name,
      createdAt: stamp,
      updatedAt: stamp,
    };
    tagList(backend).push(tag);
    return dto(tag, false);
  });

  backend.on('PATCH', '/annotation-tags/:id', ({ params, body }) => {
    const { tenant } = backend.requireRole('editor');
    const tag = tagOf(tenant.id, params[0]);
    const name = parseName(body.name);
    if (duplicate(tenant.id, name, tag.id)) throw conflict(name);
    tag.name = name;
    tag.updatedAt = now();
    for (const e of backend.executions) {
      for (const t of e.annotation?.tags ?? []) if (t.id === tag.id) t.name = name;
    }
    return dto(tag, false);
  });

  backend.on('DELETE', '/annotation-tags/:id', ({ params }) => {
    const { tenant } = backend.requireRole('editor');
    const tag = tagOf(tenant.id, params[0]);
    backend.ext.annotationTags = tagList(backend).filter((t) => t !== tag);
    for (const e of backend.executions) {
      if (!e.annotation) continue;
      e.annotation.tags = e.annotation.tags.filter((t) => t.id !== tag.id);
      tidy(e);
    }
    return { ok: true };
  });

  backend.on('PATCH', '/executions/:id', ({ params, body }) => {
    const { tenant } = backend.requireRole('editor');
    const execution = backend.executions.find((e) => e.id === params[0] && e.tenantId === tenant.id);
    if (!execution) throw notFound('Execution');
    const tags = body.tags;
    const vote = body.vote;
    if (tags === undefined && vote === undefined)
      throw new HttpError(400, 'validation_error', 'Give tags or vote');
    if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string'))) {
      throw new HttpError(400, 'validation_error', 'tags must be a list of ids');
    }
    if (vote !== undefined && vote !== null && vote !== 'up' && vote !== 'down') {
      throw new HttpError(400, 'validation_error', 'vote must be up, down or null');
    }
    const next = execution.annotation ?? { vote: null, tags: [] };
    if (tags !== undefined) {
      const wanted = [...new Set(tags as string[])];
      const found = wanted.map((id) => tagOf(tenant.id, id));
      next.tags = found.map(({ id, name }) => ({ id, name }));
    }
    if (vote !== undefined) next.vote = vote as 'up' | 'down' | null;
    execution.annotation = next;
    tidy(execution);
    return execution.annotation ? JSON.parse(JSON.stringify(execution.annotation)) : null;
  });
}

/** GET /executions filters `annotationTags` (comma ids, all must match) and `vote` */
export function filterExecutionList(
  _backend: MockBackend,
  executions: StoredExecution[],
  query: Record<string, string>,
): StoredExecution[] {
  const wanted = (query.annotationTags ?? '').split(',').filter(Boolean);
  return executions.filter(
    (e) =>
      wanted.every((id) => e.annotation?.tags.some((t) => t.id === id)) &&
      (!query.vote || e.annotation?.vote === query.vote),
  );
}
