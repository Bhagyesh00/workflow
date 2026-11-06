/** Form Trigger: a hosted form at test and production URLs; a submission starts a run with the answers. */
import type { NodeType } from '@workflow/workflow';
import {
  formAuthenticationProperty,
  formDescriptionProperty,
  formFieldsProperty,
  formResponseModeProperty,
  formTitleProperty,
  formTriggerOptionsProperty,
} from './form/fields';
import { userAuthProperties } from './form/user-auth';
import { formTriggerWebhook } from './form/webhook';

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
    credentials: [
      {
        name: 'httpBasicAuth',
        required: true,
        displayOptions: { show: { authentication: ['basicAuth'] } },
      },
    ],
    eventTriggerDescription: 'Waiting for you to submit the test form',
    activationMessage: 'You can now make calls to your production Form URL.',
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
    properties: [
      { displayName: 'Path', name: 'path', type: 'hidden', default: '' },
      formAuthenticationProperty,
      ...userAuthProperties,
      formTitleProperty,
      formDescriptionProperty,
      formFieldsProperty,
      formResponseModeProperty,
      formTriggerOptionsProperty,
    ],
  },

  webhook: formTriggerWebhook,
};
