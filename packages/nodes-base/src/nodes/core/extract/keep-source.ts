/** Keep Source of Extract from File: which parts of the input item stay on the output item. */
import { type DataObject, deepCopy, type Item, type NodeProperty } from '@workflow/workflow';

export type KeepSourceMode = 'none' | 'json' | 'binary' | 'both';

/**
 * Read the option at run time. Saved workflows from before the options field hold a boolean:
 * `true` kept both (`both`), `false` or unset kept nothing (`none`, also n8n's unset result).
 */
export function keepSourceMode(value: unknown): KeepSourceMode {
  if (value === true) return 'both';
  if (value === 'json' || value === 'binary' || value === 'both') return value;
  return 'none';
}

/** the input parts to start the output item from */
export function keptSource(mode: KeepSourceMode, input: Item): { json: DataObject; binary?: Item['binary'] } {
  const json = mode === 'json' || mode === 'both' ? deepCopy(input.json) : {};
  const binary = (mode === 'binary' || mode === 'both') && input.binary ? input.binary : undefined;
  return binary ? { json, binary } : { json };
}

/** the Keep Source option (inside the Options collection) */
export const keepSourceOption: NodeProperty = {
  displayName: 'Keep Source',
  name: 'keepSource',
  type: 'options',
  default: 'json',
  description: 'Which parts of the input item are kept on the output item',
  options: [
    { name: 'JSON', value: 'json', description: 'Keep the input fields' },
    { name: 'Binary', value: 'binary', description: 'Keep the input files' },
    { name: 'Both', value: 'both', description: 'Keep the input fields and files' },
  ],
  displayOptions: { show: { '/operation': ['fromJson', 'text', 'binaryToPropery', 'pdf'] } },
};
