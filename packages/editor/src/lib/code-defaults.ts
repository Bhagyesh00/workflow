/**
 * Swaps untouched default code when a Code node's language or mode changes, as n8n does. The texts
 * match the defaults of core.code in nodes-base (a test there compares them). Edited code is kept.
 */
import type { NodeParameters } from '@workflow/workflow';

type Mode = 'runOnceForAllItems' | 'runOnceForEachItem';

export const CODE_DEFAULTS: Record<'jsCode' | 'pythonCode', Record<Mode, string>> = {
  jsCode: {
    runOnceForAllItems:
      '// Loop over input items and add a new field called "myNewField" to the JSON of each one\nreturn $input.all().map((item) => ({\n  json: { ...item.json, myNewField: 1 },\n}));\n',
    runOnceForEachItem:
      '// Add a new field called "myNewField" to the JSON of the item\nreturn { ...$json, myNewField: 1 };\n',
  },
  pythonCode: {
    runOnceForAllItems:
      '# Loop over input items and add a new field called "my_new_field" to the JSON of each one\nfor item in _items:\n    item["json"]["my_new_field"] = 1\nreturn _items\n',
    runOnceForEachItem:
      '# Add a new field called "my_new_field" to the JSON of the item\n_item["json"]["my_new_field"] = 1\nreturn _item\n',
  },
};

function codeField(parameters: NodeParameters): 'jsCode' | 'pythonCode' {
  const { language } = parameters;
  return language === 'pythonNative' || language === 'python' ? 'pythonCode' : 'jsCode';
}

function modeOf(parameters: NodeParameters): Mode {
  return parameters.mode === 'runOnceForEachItem' ? 'runOnceForEachItem' : 'runOnceForAllItems';
}

/** @returns the node's parameters to keep, given the parameters before and after the change */
export function applyCodeDefaults(
  type: string,
  prev: NodeParameters,
  next: NodeParameters,
): NodeParameters {
  if (type !== 'core.code') return next;
  const field = codeField(next);
  const mode = modeOf(next);
  if (field === codeField(prev) && mode === modeOf(prev)) return next;
  const current = next[field];
  const defaults = CODE_DEFAULTS[field];
  const untouched =
    current === undefined || current === '' || Object.values(defaults).includes(current as string);
  if (!untouched || current === defaults[mode]) return next;
  return { ...next, [field]: defaults[mode] };
}
