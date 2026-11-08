/**
 * Registers the editor's commands with the command bar while the editor is open (P3-01): add node,
 * sticky, nodes in workflow, test workflow, tidy up, select all, rename, add tag, settings,
 * duplicate, download, import, publish / unpublish, archive (unarchive / delete when archived),
 * import from URL (P3-13). Write commands are hidden for read-only. There is no Save command (as
 * in n8n). Open sub-workflow and Open credential (P3-12) list one child per target and are hidden
 * when there is none.
 */
import { useQueryClient } from '@tanstack/react-query';
import type { ReactFlowInstance } from '@xyflow/react';
import { useEffect, useMemo } from 'react';
import { useMe } from '../../api/queries';
import { useBuilderStore } from '../../stores/builder-store';
import { useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { addNodeFromDescription } from '../editor/add-node';
import type { EditorDeps } from '../editor/editor-actions';
import {
  credentialTargets,
  openCredential,
  openSubWorkflow,
  subWorkflowTargets,
} from '../editor/open-resources';
import { publishWorkflow, unpublishWorkflow } from '../editor/publish-actions';
import { tidyUp } from '../editor/tidy-up';
import { addStickyAt, downloadWorkflow, duplicateWorkflow } from '../editor/workflow-commands';
import { archiveWorkflow, deleteArchivedWorkflow, unarchiveWorkflow } from '../workflows/archive-actions';
import { type Command, registerCommands, useCommandRegistry } from './commands';

export interface EditorCommandsInput {
  deps: EditorDeps;
  flow: ReactFlowInstance;
  save: () => Promise<void>;
  execute: () => void;
}

const SECTION = 'Workflow';

export function useEditorCommands({ deps, flow, execute }: EditorCommandsInput): void {
  const readOnly = useWorkflowStore((s) => s.readOnly);
  const streaming = useBuilderStore((s) => s.streaming);
  // a streaming builder turn owns the canvas: lock edit commands like read only
  const locked = readOnly || streaming;
  const workflowId = useWorkflowStore((s) => s.meta.id);
  const published = useWorkflowStore((s) => s.meta.active);
  const archived = useWorkflowStore((s) => s.meta.isArchived);
  const nodes = useWorkflowStore((s) => s.nodes);
  const viewer = useMe().data?.role === 'viewer';
  const queryClient = useQueryClient();

  // nodes can be added while the workflow is editable; the picked node is selected, not opened
  useEffect(() => {
    if (locked) return;
    const { setNodeAdder } = useCommandRegistry.getState();
    setNodeAdder((description, parameters) =>
      addNodeFromDescription(description, {
        flow,
        descriptions: deps.descriptions,
        parameters,
        openNdv: false,
      }),
    );
    return () => setNodeAdder(null);
  }, [locked, flow, deps.descriptions]);

  const commands = useMemo<Command[]>(() => {
    const store = () => useWorkflowStore.getState();
    const ui = () => useUiStore.getState();
    const actionDeps = { navigate: deps.navigate, queryClient };
    const list: Command[] = [];
    const add = (command: Omit<Command, 'description'>) => list.push({ ...command, description: SECTION });

    if (!locked) {
      add({
        id: 'add-node',
        title: 'Add node',
        keywords: ['node', 'step', 'create'],
        keepOpen: true,
        run: ({ goToTab }) => goToTab('nodes'),
      });
      add({
        id: 'add-sticky',
        title: 'Add sticky note',
        keywords: ['note', 'comment'],
        run: () => {
          addStickyAt(flow);
        },
      });
    }
    add({
      id: 'nodes-in-workflow',
      title: 'Nodes in workflow',
      keywords: ['open node', 'find node', 'go to node'],
      children: () =>
        store().nodes.map((node) => ({
          id: `node:${node.id}`,
          title: node.name,
          description: deps.descriptions.get(node.type)?.displayName ?? node.type,
          run: () => {
            store().select({ nodes: [node.name], stickies: [], edges: [] });
            void flow.setCenter(node.position[0] + 110, node.position[1] + 32, { zoom: 1.1, duration: 300 });
            ui().openNdv(node.name);
          },
        })),
    });
    const subWorkflows = subWorkflowTargets(nodes);
    if (subWorkflows.length)
      add({
        id: 'open-sub-workflow',
        title: 'Open sub-workflow',
        keywords: ['execute workflow', 'child workflow'],
        children: () =>
          subWorkflows.map((target) => ({
            id: `sub-workflow:${target.nodeName}`,
            title: target.label,
            description: target.nodeName,
            run: () => openSubWorkflow(target.nodeName),
          })),
      });
    const credentials = viewer ? [] : credentialTargets(nodes);
    if (credentials.length)
      add({
        id: 'open-credential',
        title: 'Open credential',
        keywords: ['credentials', 'secret', 'connection'],
        children: () =>
          credentials.map((target) => ({
            id: `credential:${target.id}`,
            title: target.name,
            description: target.type,
            run: () => openCredential(target.id),
          })),
      });
    if (!locked) {
      add({
        id: 'test-workflow',
        title: 'Test workflow',
        keywords: ['run', 'execute'],
        run: () => execute(),
      });
      add({
        id: 'tidy-up',
        title: 'Tidy up workflow',
        keywords: ['layout', 'arrange', 'align'],
        run: () => tidyUp(flow),
      });
    }
    add({ id: 'select-all', title: 'Select all', run: () => store().selectAll() });
    if (!locked) {
      add({
        id: 'rename-workflow',
        title: 'Rename workflow',
        keywords: ['name'],
        run: () => ui().setWorkflowRenameRequested(true),
      });
      add({
        id: 'add-tag',
        title: 'Add tag',
        keywords: ['tags', 'label'],
        run: () => ui().setTagsEditRequested(true),
      });
    }
    add({
      id: 'workflow-settings',
      title: 'Workflow settings',
      keywords: ['settings', 'timezone', 'error workflow'],
      run: () => ui().setSettingsOpen(true),
    });
    if (!locked) {
      add({
        id: 'duplicate-workflow',
        title: 'Duplicate workflow',
        keywords: ['copy', 'clone'],
        run: async () => {
          await duplicateWorkflow(deps);
        },
      });
    }
    add({
      id: 'download-workflow',
      title: 'Download workflow',
      keywords: ['export', 'json'],
      run: () => downloadWorkflow(),
    });
    if (!locked) {
      add({
        id: 'import-file',
        title: 'Import from file',
        keywords: ['upload', 'json'],
        run: () => {
          ui().setImportOpen(true);
          deps.navigate('/workflows');
        },
      });
      add({
        id: 'import-url',
        title: 'Import from URL',
        keywords: ['download', 'json', 'link'],
        run: () => ui().setImportUrlOpen(true),
      });
      add(
        published
          ? {
              id: 'unpublish-workflow',
              title: 'Unpublish workflow',
              keywords: ['deactivate', 'turn off'],
              run: async () => {
                await unpublishWorkflow(deps);
              },
            }
          : {
              id: 'publish-workflow',
              title: 'Publish workflow',
              keywords: ['activate', 'turn on'],
              run: async () => {
                await publishWorkflow(deps, {});
              },
            },
      );
    }
    // archiving follows the role, not the read-only state an archived workflow opens in
    if (workflowId && !viewer) {
      if (archived) {
        add({
          id: 'unarchive-workflow',
          title: 'Unarchive workflow',
          keywords: ['restore'],
          run: async () => {
            await unarchiveWorkflow(workflowId, actionDeps);
          },
        });
        add({
          id: 'delete-workflow',
          title: 'Delete workflow',
          keywords: ['remove'],
          run: async () => {
            await deleteArchivedWorkflow(workflowId, actionDeps);
          },
        });
      } else if (!locked) {
        add({
          id: 'archive-workflow',
          title: 'Archive workflow',
          run: async () => {
            await archiveWorkflow(workflowId, actionDeps);
          },
        });
      }
    }
    return list;
  }, [deps, flow, execute, queryClient, locked, workflowId, published, archived, viewer, nodes]);

  useEffect(() => registerCommands('editor', commands), [commands]);
}
