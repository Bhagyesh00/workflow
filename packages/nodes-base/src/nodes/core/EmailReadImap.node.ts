/** Stub of Email Trigger (IMAP): final name and description; L17 (P4-12) builds it. */
import type { NodeType } from '@workflow/workflow';

export const EmailReadImapNode: NodeType = {
  description: {
    name: 'core.emailReadImap',
    displayName: 'Email Trigger (IMAP)',
    description: 'Starts a run on new mail as simple, resolved or raw items',
    icon: 'lucide:inbox',
    iconColor: '#44aa22',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Email Trigger (IMAP)' },
    inputs: [],
    outputs: ['main'],
    categories: ['Core', 'Communication', 'Triggers'],
    alias: ['email', 'imap', 'mail', 'inbox', 'mailbox'],
    credentials: [{ name: 'imap', required: true }],
    properties: [],
  },

  async trigger() {
    throw new Error('Not built yet');
  },
};
