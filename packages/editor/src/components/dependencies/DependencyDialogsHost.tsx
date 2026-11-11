/**
 * P6-86: renders the dependency dialog asked for (the "Dependencies" list of the header menu, the unpublish
 * warning); mounted once, in App.tsx's ShellRoot beside ProjectDialogsHost.
 */
import type { ReactNode } from 'react';
import { useDependencyDialogStore } from '../../stores/dependency-dialog-store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { DependencyDetails, UsedByNotice } from './DependencyDetails';

export function DependencyDialogsHost(): ReactNode {
  const request = useDependencyDialogStore((s) => s.request);
  const close = useDependencyDialogStore((s) => s.close);
  if (!request) return null;

  if (request.type === 'details') {
    return (
      <Dialog
        open
        onClose={close}
        title={`Dependencies of “${request.name}”`}
        description="What this uses and what uses it. You only see what you can open."
        size="sm"
        footer={<Button onClick={close}>Close</Button>}
      >
        <DependencyDetails kind={request.kind} id={request.id} onClose={close} />
      </Dialog>
    );
  }

  const settle = (ok: boolean) => {
    request.resolve(ok);
    useDependencyDialogStore.setState({ request: null });
  };
  return (
    <Dialog
      open
      onClose={() => settle(false)}
      title={`Unpublish “${request.name}”?`}
      description="Published workflows depend on it. They stop working correctly while it is unpublished."
      size="sm"
      footer={
        <>
          <Button onClick={() => settle(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => settle(true)} data-autofocus>
            Unpublish
          </Button>
        </>
      }
    >
      <UsedByNotice rows={request.dependents} />
    </Dialog>
  );
}
