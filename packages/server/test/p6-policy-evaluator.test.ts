/**
 * P6-48 (L1): the pure evaluator of one policy scope, the write-time lint and the package index. Floors come
 * first, then normal attachments (priority ascending), rules flattened, first match wins, else the scope's
 * default; `name` reaches a tool variant through its base, `package` goes through the package index, and
 * `extends` is a credential selector.
 */
import { randomUUID } from 'node:crypto';
import type { NodePackage, NodeType } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { evaluateScope } from '../src/services/type-policies/evaluator';
import { lintRules } from '../src/services/type-policies/lint';
import { buildPackageIndex } from '../src/services/type-policies/package-index';
import type {
  PolicyAction,
  PolicyAttachment,
  PolicyDocument,
  PolicyKind,
  PolicyRule,
  PolicyScope,
  PolicySelector,
} from '../src/services/type-policies/types';

const TENANT = randomUUID();

const rule = (action: PolicyAction, selector: PolicySelector): PolicyRule => ({
  id: randomUUID(),
  action,
  selector,
});

function doc(kind: PolicyKind, rules: PolicyRule[]): PolicyDocument {
  return {
    id: randomUUID(),
    tenantId: TENANT,
    kind,
    name: randomUUID(),
    description: null,
    rules,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function scopeOf(
  kind: PolicyKind,
  defaultAction: PolicyAction,
  attachments: PolicyAttachment[],
  projectId: string | null = null,
): PolicyScope {
  return { id: randomUUID(), tenantId: TENANT, kind, projectId, defaultAction, version: 1, attachments };
}

const policiesOf = (...docs: PolicyDocument[]) => new Map(docs.map((d) => [d.id, d]));
const attach = (d: PolicyDocument, priority: number, isFloor = false): PolicyAttachment => ({
  policyId: d.id,
  priority,
  isFloor,
});

describe('evaluateScope', () => {
  it('allows everything in an unwritten scope and answers the default when no rule matches', () => {
    const open = scopeOf('node', 'allow', []);
    expect(evaluateScope(open, 'core.set', { kind: 'node', policies: new Map() })).toEqual({
      action: 'allow',
      matchedRuleId: null,
      scope: 'workspace',
      optInAvailable: false,
    });
    const d = doc('node', [rule('allow', { name: 'core.set' })]);
    const closed = scopeOf('node', 'deny', [attach(d, 0)]);
    expect(evaluateScope(closed, 'core.http', { kind: 'node', policies: policiesOf(d) })).toMatchObject({
      action: 'deny',
      matchedRuleId: null,
    });
  });

  it('first match wins, in the order of the rules of one document', () => {
    const allow = rule('allow', { name: 'core.set' });
    const deny = rule('deny', { name: 'core.set' });
    const d = doc('node', [allow, deny]);
    const decision = evaluateScope(scopeOf('node', 'deny', [attach(d, 0)]), 'core.set', {
      kind: 'node',
      policies: policiesOf(d),
    });
    expect(decision).toMatchObject({ action: 'allow', matchedRuleId: allow.id });
  });

  it('flattens documents by priority, and floors are judged before normal attachments', () => {
    const lateDeny = doc('node', [rule('deny', { name: 'core.set' })]);
    const earlyAllow = doc('node', [rule('allow', { name: 'core.set' })]);
    const policies = policiesOf(lateDeny, earlyAllow);
    // priority ascending: the allow at 1 decides before the deny at 2
    const plain = scopeOf('node', 'deny', [attach(lateDeny, 2), attach(earlyAllow, 1)]);
    expect(evaluateScope(plain, 'core.set', { kind: 'node', policies }).action).toBe('allow');
    // the same two, with the deny a floor at a worse priority: the floor still goes first
    const floored = scopeOf('node', 'allow', [attach(earlyAllow, 0), attach(lateDeny, 9, true)]);
    const decision = evaluateScope(floored, 'core.set', { kind: 'node', policies });
    expect(decision.action).toBe('deny');
    expect(decision.matchedRuleId).toBe(lateDeny.rules[0].id);
    // floors among themselves go by priority too
    const second = doc('node', [rule('allow', { name: 'core.set' })]);
    const twoFloors = scopeOf('node', 'deny', [attach(lateDeny, 5, true), attach(second, 3, true)]);
    expect(
      evaluateScope(twoFloors, 'core.set', { kind: 'node', policies: policiesOf(lateDeny, second) }).action,
    ).toBe('allow');
  });

  it('skips an attachment whose document is missing or of the other kind', () => {
    const wrongKind = doc('credential', [rule('deny', { name: 'core.set' })]);
    const s = scopeOf('node', 'allow', [
      attach(wrongKind, 0),
      { policyId: randomUUID(), priority: 1, isFloor: false },
    ]);
    expect(evaluateScope(s, 'core.set', { kind: 'node', policies: policiesOf(wrongKind) }).action).toBe(
      'allow',
    );
  });

  it('a name rule on the base reaches the Tool and HitlTool variants, a rule on a variant only that variant', () => {
    const d = doc('node', [rule('deny', { name: 'app.slack' })]);
    const s = scopeOf('node', 'allow', [attach(d, 0)]);
    const policies = policiesOf(d);
    expect(evaluateScope(s, 'app.slack', { kind: 'node', policies }).action).toBe('deny');
    expect(evaluateScope(s, 'app.slackTool', { kind: 'node', baseName: 'app.slack', policies }).action).toBe(
      'deny',
    );
    expect(
      evaluateScope(s, 'app.slackHitlTool', { kind: 'node', baseName: 'app.slack', policies }).action,
    ).toBe('deny');
    expect(evaluateScope(s, 'app.slackTrigger', { kind: 'node', policies }).action).toBe('allow');
    const onVariant = doc('node', [rule('deny', { name: 'app.slackTool' })]);
    const s2 = scopeOf('node', 'allow', [attach(onVariant, 0)]);
    const p2 = policiesOf(onVariant);
    expect(evaluateScope(s2, 'app.slack', { kind: 'node', policies: p2 }).action).toBe('allow');
    expect(
      evaluateScope(s2, 'app.slackTool', { kind: 'node', baseName: 'app.slack', policies: p2 }).action,
    ).toBe('deny');
  });

  it('a package rule matches the type of that package only', () => {
    const d = doc('node', [rule('deny', { package: '@workflow/nodes-ai' })]);
    const s = scopeOf('node', 'allow', [attach(d, 0)]);
    const policies = policiesOf(d);
    expect(
      evaluateScope(s, 'ai.agent', { kind: 'node', packageName: '@workflow/nodes-ai', policies }).action,
    ).toBe('deny');
    expect(
      evaluateScope(s, 'core.set', { kind: 'node', packageName: '@workflow/nodes-base', policies }).action,
    ).toBe('allow');
    // no known package: nothing matches
    expect(evaluateScope(s, 'x.y', { kind: 'node', policies }).action).toBe('allow');
  });

  it('an extends rule covers the credential type and its children, and never matches in a node scope', () => {
    const d = doc('credential', [rule('deny', { extends: 'oAuth2Api' })]);
    const s = scopeOf('credential', 'allow', [attach(d, 0)]);
    const policies = policiesOf(d);
    const child = { kind: 'credential' as const, ancestors: ['oAuth2Api'], policies };
    expect(evaluateScope(s, 'googleOAuth2Api', child).action).toBe('deny');
    expect(evaluateScope(s, 'oAuth2Api', { kind: 'credential', policies }).action).toBe('deny');
    expect(evaluateScope(s, 'httpBasicAuth', { kind: 'credential', policies }).action).toBe('allow');
    const nodeScope = scopeOf('node', 'allow', [attach(d, 0)]);
    expect(evaluateScope(nodeScope, 'oAuth2Api', { kind: 'node', policies }).action).toBe('allow');
  });

  it('a workspace delegate says the project may opt in; a project scope never delegates', () => {
    const workspace = scopeOf('node', 'delegate', []);
    expect(evaluateScope(workspace, 'core.set', { kind: 'node', policies: new Map() })).toEqual({
      action: 'delegate',
      matchedRuleId: null,
      scope: 'workspace',
      optInAvailable: true,
    });
    const d = doc('node', [rule('delegate', { name: 'core.set' })]);
    const viaRule = evaluateScope(scopeOf('node', 'allow', [attach(d, 0)]), 'core.set', {
      kind: 'node',
      policies: policiesOf(d),
    });
    expect(viaRule).toMatchObject({ action: 'delegate', matchedRuleId: d.rules[0].id, optInAvailable: true });
    // defensive: a project scope holding a delegate rule denies
    const project = scopeOf('node', 'allow', [attach(d, 0)], randomUUID());
    expect(evaluateScope(project, 'core.set', { kind: 'node', policies: policiesOf(d) })).toMatchObject({
      action: 'deny',
      scope: 'project',
      optInAvailable: false,
    });
  });

  it('a rule with an empty selector matches nothing', () => {
    const d = doc('node', [rule('deny', {})]);
    const s = scopeOf('node', 'allow', [attach(d, 0)]);
    expect(evaluateScope(s, 'core.set', { kind: 'node', policies: policiesOf(d) }).action).toBe('allow');
  });
});

describe('lintRules', () => {
  const known = {
    types: new Set(['core.set', 'ai.agent']),
    packages: new Set(['@workflow/nodes-base']),
  };

  it('is quiet for rules that match a loaded type or package', () => {
    expect(
      lintRules(
        'node',
        [rule('deny', { name: 'core.set' }), rule('allow', { package: '@workflow/nodes-base' })],
        known,
      ),
    ).toEqual([]);
  });

  it('warns shadowed for a rule an earlier one already covers, and notLoaded for an unknown type or package', () => {
    const first = rule('allow', { name: 'core.set' });
    const second = rule('deny', { name: 'core.set' });
    const ghost = rule('deny', { name: 'core.nothing' });
    const pkg = rule('deny', { package: '@acme/missing' });
    const warnings = lintRules('node', [first, second, ghost, pkg], known);
    expect(warnings.map((w) => [w.code, w.ruleId])).toEqual([
      ['shadowed', second.id],
      ['notLoaded', ghost.id],
      ['notLoaded', pkg.id],
    ]);
    for (const w of warnings) expect(w.message.length).toBeGreaterThan(0);
  });

  it('refuses an extends selector in a node policy, and malformed rules, with 400', () => {
    const refused = (kind: PolicyKind, rules: PolicyRule[]) => {
      try {
        lintRules(kind, rules, known);
      } catch (error) {
        return (error as { statusCode?: number }).statusCode;
      }
      return undefined;
    };
    expect(refused('node', [rule('deny', { extends: 'oAuth2Api' })])).toBe(400);
    expect(refused('credential', [rule('deny', { extends: 'oAuth2Api' })])).toBeUndefined();
    expect(refused('node', [rule('deny', {})])).toBe(400);
    expect(refused('node', [rule('deny', { name: 'a', package: 'b' })])).toBe(400);
    expect(refused('node', [rule('deny', { name: ' ' })])).toBe(400);
    const dup = rule('deny', { name: 'core.set' });
    expect(refused('node', [dup, { ...dup, selector: { name: 'ai.agent' } }])).toBe(400);
    expect(refused('node', [{ ...rule('deny', { name: 'x' }), action: 'maybe' as PolicyAction }])).toBe(400);
  });

  it('checks the extends selector against the loaded credential types', () => {
    const creds = { types: new Set(['oAuth2Api']), packages: new Set(['@workflow/nodes-base']) };
    const ok = rule('deny', { extends: 'oAuth2Api' });
    const missing = rule('deny', { extends: 'nopeApi' });
    expect(lintRules('credential', [ok, missing], creds).map((w) => [w.code, w.ruleId])).toEqual([
      ['notLoaded', missing.id],
    ]);
  });
});

describe('buildPackageIndex', () => {
  const nodeType = (name: string, extra: Partial<NodeType['description']> = {}): NodeType =>
    ({
      description: {
        name,
        displayName: name,
        version: 1,
        description: name,
        defaults: { name },
        inputs: ['main'],
        outputs: ['main'],
        properties: [],
        ...extra,
      },
    }) as unknown as NodeType;

  const pkg = (name: string, nodes: NodeType[], credentials: string[] = []): NodePackage =>
    ({
      name,
      nodes,
      credentials: credentials.map((c) => ({ name: c, displayName: c, properties: [] })),
    }) as unknown as NodePackage;

  it('maps node and credential types to their package, the later package winning a shared name', () => {
    const index = buildPackageIndex([
      pkg('@workflow/nodes-base', [nodeType('core.set'), nodeType('core.shared')], ['httpBasicAuth']),
      pkg('@workflow/nodes-ai', [nodeType('ai.agent'), nodeType('core.shared')], ['openAiApi']),
    ]);
    expect(index.nodes.get('core.set')).toBe('@workflow/nodes-base');
    expect(index.nodes.get('ai.agent')).toBe('@workflow/nodes-ai');
    expect(index.nodes.get('core.shared')).toBe('@workflow/nodes-ai');
    expect(index.credentials.get('httpBasicAuth')).toBe('@workflow/nodes-base');
    expect(index.credentials.get('openAiApi')).toBe('@workflow/nodes-ai');
    expect(index.nodes.has('nope')).toBe(false);
  });

  it('lists the tool variants of a node in its package, with their base', () => {
    const index = buildPackageIndex([
      pkg('@workflow/nodes-base', [nodeType('app.slack', { usableAsTool: true })]),
    ]);
    expect(index.nodes.get('app.slackTool')).toBe('@workflow/nodes-base');
    expect(index.bases.get('app.slackTool')).toBe('app.slack');
    expect(index.bases.has('app.slack')).toBe(false);
  });
});
