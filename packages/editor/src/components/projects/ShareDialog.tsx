/**
 * P6-44: share a workflow or credential with projects (a project picker; the full list goes to PUT
 * `/:id/share`). A personal credential without `credential:share` shows "Sharing is disabled in personal
 * spaces..."; `credential:shareGlobally` adds the share with all users control (`isGlobal`).
 */
export interface ShareDialogProps {
  resource: 'workflow' | 'credential';
  id: string;
  onClose(): void;
}

export function ShareDialog(_props: ShareDialogProps) {
  // stub (L21)
  return null;
}
