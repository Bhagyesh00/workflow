import type {
  DisplayOptions,
  NodeProperty,
  NodePropertyCollection,
  NodePropertyOption,
} from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { credentials, nodes, nodesBasePackage } from '../src';
import { credentialTypes } from './harness';

function isCollection(o: unknown): o is NodePropertyCollection {
  return !!o && typeof o === 'object' && Array.isArray((o as NodePropertyCollection).values);
}
function isProperty(o: unknown): o is NodeProperty {
  return (
    !!o &&
    typeof o === 'object' &&
    'type' in (o as object) &&
    'name' in (o as object) &&
    'displayName' in (o as object)
  );
}

/** every (sibling list, property) pair, recursing into collections */
function walk(properties: NodeProperty[], visit: (property: NodeProperty, siblings: NodeProperty[]) => void) {
  for (const p of properties) {
    visit(p, properties);
    const children = (p.options ?? []).filter(isProperty);
    if (children.length) walk(children, visit);
    for (const c of (p.options ?? []).filter(isCollection)) walk(c.values, visit);
  }
}

describe('node descriptions', () => {
  it('exports a package with unique node and credential names', () => {
    expect(nodesBasePackage.nodes).toBe(nodes);
    expect(new Set(nodes.map((n) => n.description.name)).size).toBe(nodes.length);
    expect(new Set(credentials.map((c) => c.name)).size).toBe(credentials.length);
    expect(nodes.length).toBeGreaterThanOrEqual(46);
  });

  it.each(nodes.map((n) => [n.description.name, n] as const))('%s is well-formed', (_name, type) => {
    const d = type.description;
    expect(d.name).toMatch(/^(core|app)\.[a-z][A-Za-z0-9]*$/);
    expect(d.displayName).toBeTruthy();
    expect(d.description.length).toBeGreaterThan(10);
    expect(d.defaults.name).toBeTruthy();
    expect(d.categories?.length).toBeGreaterThan(0);
    expect(d.icon).toMatch(d.name.startsWith('core.') ? /^lucide:[a-z0-9-]+$/ : /^simple:[a-z0-9]+$/);
    if (
      !d.name.endsWith('Trigger') &&
      !['core.manualTrigger', 'core.webhook', 'core.scheduleTrigger'].includes(d.name)
    ) {
      expect(d.alias?.length ?? 0).toBeGreaterThan(0);
    }
    // something runs the node
    expect(Boolean(type.execute || type.trigger || type.poll || type.webhook)).toBe(true);
    if (d.polling) expect(type.poll).toBeDefined();

    // credentials exist
    for (const c of d.credentials ?? []) expect(credentialTypes.get(c.name), c.name).toBeDefined();

    // resource/operation options name an action for the node creator
    walk(d.properties, (p) => {
      if (p.name === 'operation' && p.type === 'options' && d.name.startsWith('app.')) {
        for (const o of (p.options ?? []) as NodePropertyOption[])
          expect(o.action, `${d.name} ${String(o.value)}`).toBeTruthy();
      }
    });

    // displayOptions only reference parameters that exist
    const topLevel = new Set(d.properties.map((p) => p.name));
    walk(d.properties, (p, siblings) => {
      const refs = (opts: DisplayOptions | undefined) => [
        ...Object.keys(opts?.show ?? {}),
        ...Object.keys(opts?.hide ?? {}),
      ];
      for (const key of refs(p.displayOptions)) {
        if (key === '@version') continue;
        const exists = key.startsWith('/')
          ? topLevel.has(key.slice(1))
          : siblings.some((s) => s.name === key);
        expect(exists, `${d.name}: "${p.name}" depends on unknown "${key}"`).toBe(true);
      }
      // loadOptions / listSearch methods referenced by properties exist
      if (p.typeOptions?.loadOptionsMethod)
        expect(type.methods?.loadOptions?.[p.typeOptions.loadOptionsMethod], p.name).toBeDefined();
      for (const mode of p.modes ?? []) {
        const method = mode.typeOptions?.searchListMethod;
        // workflow search is provided by the server (the node cannot list workflows itself)
        if (method && method !== 'searchWorkflows')
          expect(type.methods?.listSearch?.[method], `${d.name} ${method}`).toBeDefined();
        if (mode.extractValue) expect(() => new RegExp(mode.extractValue!.regex)).not.toThrow();
      }
    });
  });

  it.each(credentials.map((c) => [c.name, c] as const))(
    'credential %s is well-formed',
    (_name, credential) => {
      expect(credential.name).toMatch(/^[a-z][A-Za-z0-9]*$/);
      expect(credential.displayName).toBeTruthy();
      for (const parent of credential.extends ?? []) expect(credentialTypes.get(parent)).toBeDefined();
      const resolved = credentialTypes.getResolved(credential.name)!;
      expect(resolved.properties.length).toBeGreaterThan(0);
      // secrets are marked as passwords so the API redacts them
      for (const p of resolved.properties) {
        if (
          /(secret|password|apikey)$/i.test(p.name) ||
          ['accessToken', 'token', 'value', 'json'].includes(p.name)
        ) {
          expect(p.typeOptions?.password, `${credential.name}.${p.name}`).toBe(true);
        }
      }
    },
  );

  it('service credentials extend the generic OAuth2 type with fixed URLs', () => {
    expect(credentialTypes.isA('gmailOAuth2', 'oAuth2Api')).toBe(true);
    expect(credentialTypes.isA('googleSheetsOAuth2Api', 'googleOAuth2Api')).toBe(true);
    expect(credentialTypes.isA('slackOAuth2Api', 'oAuth2Api')).toBe(true);
    const gmail = credentialTypes.getResolved('gmailOAuth2')!;
    const prop = (name: string) => gmail.properties.find((p) => p.name === name);
    expect(prop('accessTokenUrl')).toMatchObject({
      type: 'hidden',
      default: 'https://oauth2.googleapis.com/token',
    });
    expect(String(prop('scope')?.default)).toContain('gmail.modify');
    expect(gmail.test?.request.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile');
    expect(
      credentialTypes
        .getResolved('oAuth2Api')!
        .properties.find((p) => p.name === 'grantType')
        ?.options?.map((o) => (o as NodePropertyOption).value),
    ).toEqual(['authorizationCode', 'clientCredentials', 'pkce']);
  });

  it('identity test requests exist where the service offers one', () => {
    for (const name of [
      'slackApi',
      'notionApi',
      'airtableTokenApi',
      'telegramApi',
      'gmailOAuth2',
      'slackOAuth2Api',
    ]) {
      expect(credentialTypes.getResolved(name)?.test?.request.url, name).toBeTruthy();
    }
  });
});
