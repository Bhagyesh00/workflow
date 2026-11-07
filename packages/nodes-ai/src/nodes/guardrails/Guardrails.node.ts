/** Guardrails: checks text for violations or masks it. Stub: L10 fills it. */
import type { NodeType } from '@workflow/workflow';
import { COMPLETION_MODEL_NODES } from '../../shared/ai-inputs';

const CHAT_MODEL_INPUT = JSON.stringify({
  type: 'ai_languageModel',
  displayName: 'Chat Model',
  required: true,
  maxConnections: 1,
  filter: { excludedNodes: COMPLETION_MODEL_NODES },
});

/** the model input exists only when a check on the node needs a model */
const inputs = `={{ ['main', ...($parameter.operation !== 'sanitize' && ['jailbreak', 'nsfw', 'topicalAlignment', 'custom'].some((check) => $parameter.guardrails?.[check] !== undefined) ? [${CHAT_MODEL_INPUT}] : [])] }}`;

const outputs = `={{ $parameter.operation === 'sanitize' ? ['main'] : [{ type: 'main', displayName: 'Pass' }, { type: 'main', displayName: 'Fail' }] }}`;

export const GuardrailsNode: NodeType = {
  description: {
    name: 'ai.guardrails',
    displayName: 'Guardrails',
    description: 'Checks text for keywords, PII, secrets, URLs and policy violations, or masks what it finds',
    icon: 'lucide:shield-check',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Guardrails' },
    inputs,
    outputs,
    categories: ['AI', 'Guardrails'],
    alias: ['pii', 'moderation', 'jailbreak', 'nsfw', 'mask', 'sanitize', 'safety'],
    properties: [],
  },
  async execute() {
    throw new Error('not implemented (L10)');
  },
};
