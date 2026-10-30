import type { ConnectionType, StickyNote } from '@workflow/workflow';
import { createContext, useContext } from 'react';
import type { ConnectionRef } from '../../lib/workflow-ops';

/** What canvas elements can ask the surrounding editor to do. */
export interface CanvasActions {
  openNdv(nodeName: string): void;
  executeNode?(nodeName: string): void;
  toggleDisabled(nodeName: string): void;
  removeNode(nodeName: string): void;
  /** open the node creator connected from an output */
  addFromOutput(nodeName: string, type: ConnectionType, index: number): void;
  /** open the node creator for a sub-node plugged into an AI input */
  addSubNode(nodeName: string, type: ConnectionType, index: number): void;
  insertOnEdge(ref: ConnectionRef): void;
  removeEdge(ref: ConnectionRef): void;
  updateSticky(id: string, patch: Partial<Omit<StickyNote, 'id'>>, history?: boolean): void;
  removeSticky(id: string): void;
}

const noop = () => undefined;

export const readOnlyActions = (openNdv: (name: string) => void): CanvasActions => ({
  openNdv,
  toggleDisabled: noop,
  removeNode: noop,
  addFromOutput: noop,
  addSubNode: noop,
  insertOnEdge: noop,
  removeEdge: noop,
  updateSticky: noop,
  removeSticky: noop,
});

export const CanvasActionsContext = createContext<CanvasActions | null>(null);

export function useCanvasActions(): CanvasActions {
  const ctx = useContext(CanvasActionsContext);
  if (!ctx) throw new Error('CanvasActionsContext is missing');
  return ctx;
}
