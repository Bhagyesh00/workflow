import { screen } from '@testing-library/react';
import type { NodeTypeDescription, WorkflowNode } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { NodeCredentials, visibleCredentials } from '../src/components/credentials/NodeCredentials';
import { lintWorkflow } from '../src/lib/doctor';
import { signedIn } from './backend';
import { withProviders } from './utils';

const description: NodeTypeDescription = {
  name: 'test.httpLike',
  displayName: 'HTTP Like',
  group: ['transform'],
  version: 1,
  description: '',
  defaults: { name: 'HTTP Like' },
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    {
      displayName: 'Authentication',
      name: 'authentication',
      type: 'options',
      default: 'none',
      options: [
        { name: 'None', value: 'none' },
        { name: 'Predefined', value: 'predefinedCredentialType' },
      ],
    },
    {
      displayName: 'Credential Type',
      name: 'nodeCredentialType',
      type: 'credentialsSelect',
      default: '',
      displayOptions: { show: { authentication: ['predefinedCredentialType'] } },
    },
  ],
  credentials: [],
};

const make = (
  parameters: Record<string, unknown>,
  credentials?: WorkflowNode['credentials'],
): WorkflowNode => ({
  id: 'h',
  name: 'Call',
  type: description.name,
  typeVersion: 1,
  position: [0, 0],
  parameters,
  credentials,
});

const lookup = { get: (t: string) => (t === description.name ? description : undefined) };

describe('credentialsSelect parameters add a credential slot', () => {
  beforeEach(() => {
    signedIn();
  });

  it('lists a required slot for the chosen credential type', () => {
    const node = make({ authentication: 'predefinedCredentialType', nodeCredentialType: 'notionApi' });
    expect(visibleCredentials(node, description)).toEqual([{ name: 'notionApi', required: true }]);
  });

  it('adds no slot when the select is hidden or empty', () => {
    expect(
      visibleCredentials(make({ authentication: 'none', nodeCredentialType: 'notionApi' }), description),
    ).toEqual([]);
    expect(
      visibleCredentials(
        make({ authentication: 'predefinedCredentialType', nodeCredentialType: '' }),
        description,
      ),
    ).toEqual([]);
  });

  it('renders the credential picker', async () => {
    const node = make({ authentication: 'predefinedCredentialType', nodeCredentialType: 'notionApi' });
    withProviders(
      <NodeCredentials node={node} description={description} readOnly={false} onChange={() => {}} />,
    );
    expect(await screen.findByText('Credential to connect with')).toBeTruthy();
  });

  it('flags a missing credential in the Doctor and clears it once attached', () => {
    const params = { authentication: 'predefinedCredentialType', nodeCredentialType: 'notionApi' };
    const run = (node: WorkflowNode) => lintWorkflow({ nodes: [node], connections: {} }, lookup);
    expect(run(make(params)).some((i) => i.message === 'Needs a "notionApi" credential')).toBe(true);
    const attached = make(params, { notionApi: { id: 'c1', name: 'My Notion' } });
    expect(run(attached).some((i) => i.message.includes('credential'))).toBe(false);
  });

  it('flags a missing credential whose type is also a generic auth type the node declares', () => {
    const generic: NodeTypeDescription = {
      ...description,
      properties: [
        {
          displayName: 'Authentication',
          name: 'authentication',
          type: 'options',
          default: 'none',
          options: [
            { name: 'None', value: 'none' },
            { name: 'Predefined', value: 'predefinedCredentialType' },
            { name: 'Generic', value: 'genericCredentialType' },
          ],
        },
        description.properties[1],
      ],
      credentials: [
        {
          name: 'httpHeaderAuth',
          required: true,
          displayOptions: { show: { authentication: ['genericCredentialType'] } },
        },
      ],
    };
    const genericLookup = { get: (t: string) => (t === generic.name ? generic : undefined) };
    const params = { authentication: 'predefinedCredentialType', nodeCredentialType: 'httpHeaderAuth' };
    const run = (node: WorkflowNode) => lintWorkflow({ nodes: [node], connections: {} }, genericLookup);
    expect(visibleCredentials(make(params), generic)).toEqual([{ name: 'httpHeaderAuth', required: true }]);
    expect(run(make(params)).some((i) => i.message === 'Needs a "httpHeaderAuth" credential')).toBe(true);
    const attached = make(params, { httpHeaderAuth: { id: 'c1', name: 'Header' } });
    expect(run(attached).some((i) => i.message.includes('credential'))).toBe(false);
    const hiddenSlot = make({ authentication: 'none', nodeCredentialType: 'httpHeaderAuth' });
    expect(run(hiddenSlot).some((i) => i.message.includes('credential'))).toBe(false);
  });
});
