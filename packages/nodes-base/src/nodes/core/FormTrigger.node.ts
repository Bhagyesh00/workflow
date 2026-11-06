/** Stub of Form Trigger: final name, description and hooks; L1 (P4-01) builds it. */
import type { NodeType } from '@workflow/workflow';

// the `path` parameter, then the Form Path option; empty becomes the node's webhookId (webhook-paths.ts)
const FORM_PATH = '={{$parameter["path"] || $parameter["options"]?.path || ""}}';

export const FormTriggerNode: NodeType = {
  description: {
    name: 'core.formTrigger',
    displayName: 'Form Trigger',
    description: 'Starts a run when someone submits a hosted form',
    icon: 'lucide:clipboard-list',
    iconColor: '#7a4fd6',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'On form submission' },
    inputs: [],
    outputs: ['main'],
    categories: ['Core', 'Triggers'],
    webhooks: [
      {
        name: 'setup',
        httpMethod: 'GET',
        path: FORM_PATH,
        isFullPath: true,
        responseMode: 'onReceived',
        ndvHideUrl: true,
        nodeType: 'form',
      },
      {
        name: 'default',
        httpMethod: 'POST',
        path: FORM_PATH,
        isFullPath: true,
        responseMode: '={{$parameter["responseMode"]}}',
        responseData: '={{$parameter["responseMode"] === "lastNode" ? "noData" : undefined}}',
        nodeType: 'form',
      },
    ],
    properties: [],
  },

  async webhook() {
    throw new Error('Not built yet');
  },
};
