/** Conversions between database rows, engine definitions and API DTOs. */
import type {
  Connections,
  Item,
  StickyNote,
  WorkflowDefinition,
  WorkflowNode,
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
  active: boolean;
  versionId: string;
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
    active: row.active,
    versionId: row.versionId,
    tags,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** JSON-safe deep copy of a definition (drops functions/undefined, unfreezes) */
export function cloneDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  return JSON.parse(JSON.stringify(definition)) as WorkflowDefinition;
}
