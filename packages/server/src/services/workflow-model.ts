/** Conversions between database rows, engine definitions and API DTOs. */
import type {
  Connections,
  Item,
  StickyNote,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeGroup,
  WorkflowSettings,
} from '@workflow/workflow';
import type { WorkflowRow } from '../db/schema';
import type { TagRef } from '../repositories';

export interface WorkflowDTO {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  connections: Connections;
  settings: WorkflowSettings;
  pinData: Record<string, Item[]>;
  stickyNotes: StickyNote[];
  /** P3-04 canvas groups */
  nodeGroups: WorkflowNodeGroup[];
  active: boolean;
  versionId: string;
  /** P3-07 */
  folderId: string | null;
  isArchived: boolean;
  /** P3-10: the published version (null = not published) */
  publishedVersionId: string | null;
  tags: TagRef[];
  createdAt: string;
  updatedAt: string;
}

export function toDefinition(row: WorkflowRow): WorkflowDefinition {
  return {
    id: row.id,
    name: row.name,
    nodes: structuredClone(row.nodes as WorkflowNode[]),
    connections: structuredClone(row.connections as Connections),
    settings: structuredClone(row.settings as WorkflowSettings),
    pinData: structuredClone(row.pinData as Record<string, Item[]>),
    staticData: structuredClone(row.staticData),
    stickyNotes: structuredClone(row.stickyNotes as StickyNote[]),
    nodeGroups: structuredClone(row.nodeGroups as WorkflowNodeGroup[]),
    versionId: row.versionId,
    active: row.active,
  };
}

export function toDTO(row: WorkflowRow, tags: TagRef[] = []): WorkflowDTO {
  return {
    id: row.id,
    name: row.name,
    nodes: row.nodes as WorkflowNode[],
    connections: row.connections as Connections,
    settings: row.settings as WorkflowSettings,
    pinData: row.pinData as Record<string, Item[]>,
    stickyNotes: row.stickyNotes as StickyNote[],
    nodeGroups: row.nodeGroups as WorkflowNodeGroup[],
    active: row.active,
    versionId: row.versionId,
    folderId: row.folderId,
    isArchived: row.isArchived,
    publishedVersionId: row.publishedVersionId,
    tags,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** JSON-safe deep copy of a definition (drops functions/undefined, unfreezes) */
export function cloneDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  return JSON.parse(JSON.stringify(definition)) as WorkflowDefinition;
}
