/** Form: the next page or the ending of a form, inside a run a Form Trigger started. */
import { NodeOperationError, type NodeType } from '@workflow/workflow';
import { defineFormProperties, formEndingProperties, formPageOptionsProperty } from './form/fields';
import { announceFormPage, FORM_TRIGGER_TYPE, formNodeWebhook } from './form/webhook';
import { limitedWaitUntil, limitWaitProperties } from './wait-limit';

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
    properties: [
      {
        displayName: 'Page Type',
        name: 'operation',
        type: 'options',
        default: 'page',
        noDataExpression: true,
        options: [
          { name: 'Next Form Page', value: 'page', description: 'Ask for more answers' },
          { name: 'Form Ending', value: 'completion', description: 'What the person sees at the end' },
        ],
      },
      ...defineFormProperties,
      ...formEndingProperties,
      ...limitWaitProperties(),
      formPageOptionsProperty,
    ],
  },

  async execute(ctx) {
    if (!ctx.getParentNodes().some((node) => node.type === FORM_TRIGGER_TYPE)) {
      throw new NodeOperationError(ctx.getNode(), 'Form Trigger node must be set before this node');
    }
    const isEnding = ctx.getNodeParameter('operation', 0, 'page') === 'completion';
    if (isEnding && ctx.getChildNodes().some((node) => node.type === 'core.form')) {
      throw new NodeOperationError(ctx.getNode(), 'Completion has to be the last Form node in the workflow');
    }
    await ctx.putExecutionToWait(limitedWaitUntil(ctx));
    announceFormPage(ctx, true);
    return [ctx.getInputData()];
  },

  webhook: formNodeWebhook,
};
