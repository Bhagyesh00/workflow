/**
 * Renders the credential modal for ui.openCredentialId (P3-12 "Open credential").
 * Closing it, or saving, clears the id.
 */
import { CredentialModal } from '../../components/credentials/CredentialModal';
import { useUiStore } from '../../stores/ui-store';

export function OpenCredentialHost() {
  const credentialId = useUiStore((s) => s.openCredentialId);
  const close = () => useUiStore.getState().setOpenCredentialId(null);
  if (!credentialId) return null;
  return <CredentialModal open onClose={close} credentialId={credentialId} onSaved={close} />;
}
