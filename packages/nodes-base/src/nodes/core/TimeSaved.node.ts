/**
 * Track Time Saved (P6-56, n8n "Time Saved"): adds minutes to the run's time saved when the workflow's
 * `timeSavedMode` is `dynamic`, once for the node or per input item, and passes its input through.
 */
import { NodeOperationError, type NodeType } from '@workflow/workflow';

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

  async execute(ctx) {
    const items = ctx.getInputData();
    const mode = String(ctx.getNodeParameter('mode', 0, 'once'));
    const read = (itemIndex: number): number => {
      const raw = ctx.getNodeParameter('minutesSaved', itemIndex, 0);
      const minutes = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(minutes)) {
        throw new NodeOperationError(ctx.getNode(), `Time saved must be a number, got: ${String(raw)}`, {
          itemIndex,
        });
      }
      if (minutes < 0) {
        throw new NodeOperationError(ctx.getNode(), `Time saved cannot be negative, got: ${minutes}`, {
          itemIndex,
        });
      }
      return Math.trunc(minutes);
    };
    let total = 0;
    if (mode === 'perItem') for (let i = 0; i < items.length; i++) total += read(i);
    else total = read(0);
    ctx.setMetadata({ timeSaved: { minutes: total } });
    return [items];
  },
};
