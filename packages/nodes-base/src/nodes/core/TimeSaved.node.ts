/**
 * Track Time Saved (P6-56, n8n "Time Saved"): adds minutes to the run's time saved when the workflow's
 * `timeSavedMode` is `dynamic`, once for the node or per input item, and passes its input through.
 * stub (L12): the description is final; L12 fills `execute`.
 */
import type { NodeType } from '@workflow/workflow';

export const TimeSavedNode: NodeType = {
  description: {
    name: 'core.timeSaved',
    displayName: 'Track Time Saved',
    description: 'Adds the minutes this path saves to the time saved shown in Insights',
    icon: 'lucide:timer',
    group: ['organization'],
    version: 1,
    defaults: { name: 'Time Saved' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Flow'],
    alias: ['time saved', 'insights', 'minutes saved', 'roi', 'track time'],
    properties: [
      {
        displayName: 'Calculation Mode',
        name: 'mode',
        type: 'options',
        default: 'once',
        noDataExpression: true,
        options: [
          {
            name: 'Once For All Items',
            value: 'once',
            description: 'Counts the minutes once, whatever the item count',
          },
          { name: 'Per Item', value: 'perItem', description: 'Counts the minutes once for each input item' },
        ],
      },
      {
        displayName: 'Minutes Saved',
        name: 'minutesSaved',
        type: 'number',
        default: 0,
        required: true,
        description: 'Minutes of manual work this path saves',
        typeOptions: { minValue: 0, numberPrecision: 0 },
      },
    ],
  },

  async execute() {
    throw new Error('not implemented (L12)');
  },
};
