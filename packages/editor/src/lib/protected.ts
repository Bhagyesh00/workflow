/**
 * P6-79, P6-80: whether this workspace is protected (n8n's `branchReadOnly`): GET /settings
 * `sourceControl.readOnly`. The editor hides and locks what the server refuses; the server is the lock.
 */
import { useSettings } from '../api/queries';

/** true only when the settings say so; false while they load and when the flag is absent */
export function useProtectedWorkspace(): boolean {
  return useSettings().sourceControl?.readOnly === true;
}
