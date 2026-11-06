/** Stub of Form: final name, description and hooks; L1 (P4-02) builds it. */
import type { NodeType } from '@workflow/workflow';

export const FormNode: NodeType = {
  description: {
    name: 'core.form',
    displayName: 'Form',
    description: 'Shows the next page or the ending of a form in a running workflow',
    icon: 'lucide:file-input',
    iconColor: '#7a4fd6',
    group: ['input'],
    version: 1,
    defaults: { name: 'Form' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Flow'],
    alias: ['_Form', 'form', 'table', 'submit', 'post', 'page', 'step', 'stage', 'multi'],
    webhooks: [
      {
        name: 'default',
        httpMethod: 'GET',
        path: '',
        isFullPath: true,
        restartWebhook: true,
        responseMode: 'onReceived',
        nodeType: 'form',
      },
      {
        name: 'default',
        httpMethod: 'POST',
        path: '',
        isFullPath: true,
        restartWebhook: true,
        responseMode: 'responseNode',
        nodeType: 'form',
      },
    ],
    properties: [],
  },

  async execute() {
    throw new Error('Not built yet');
  },

  async webhook() {
    throw new Error('Not built yet');
  },
};
