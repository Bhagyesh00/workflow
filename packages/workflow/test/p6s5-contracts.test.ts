/**
 * Phase 6 S5 contract step, C0a: the event catalog (n8n's names less `n8n.`), subscriptions, OTLP header parsing
 * and custom telemetry tags. The editor bundles these files, so nothing here may need node:.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AI_EVENT_NAMES,
  type AiEventName,
  DEFAULT_CIRCUIT_BREAKER,
  DESTINATION_TEST_EVENT,
  EVENT_CATALOG,
  type EventName,
  type ExecuteContext,
  eventGroupOf,
  type LogDestination,
  matchesSubscription,
  parseOtlpHeaders,
  type SupplyDataContext,
  TELEMETRY_TAG_LIMITS,
  type TelemetryTag,
  telemetryTagsOf,
  validateTelemetryTags,
  type WorkflowNode,
  type WorkflowSettings,
} from '../src';

/** the names this stage's lanes and C0 produce (plan C0a item 1, "plus") */
const STAGE_NAMES = [
  'audit.workflow.executed',
  'audit.workflow.resumed',
  'audit.workflow.waiting',
  'audit.variable.created',
  'audit.variable.updated',
  'audit.variable.deleted',
  'audit.user.execution.deleted',
  'audit.mcp.tool.called',
  'audit.mcp.oauth.completed',
  'audit.mcp.access.updated',
  'audit.execution.data.reveal_failure',
  'audit.role-mapping.roles-resolved',
];

/** names the plan drops (section 9): no producer or no feature here */
const DROPPED = [
  'execution.throttled',
  'execution.started-during-bootup',
  'audit.user.login.emailConflict',
  'audit.user.email.failed',
  'audit.credentials.authorize.rejected',
  'audit.oauth.callback.binding.rejected',
  'audit.external-secrets.provider.settings.saved',
  'audit.external-secrets.provider.settings.reloaded',
];

const names = EVENT_CATALOG.map((entry) => entry.name);

describe('EVENT_CATALOG', () => {
  it('holds the 14 AI events as a tuple, all in the ai group', () => {
    expect(AI_EVENT_NAMES).toHaveLength(14);
    expect(new Set(AI_EVENT_NAMES).size).toBe(14);
    for (const name of AI_EVENT_NAMES) {
      expect(EVENT_CATALOG).toContainEqual({ name, group: 'ai' });
    }
    expect(EVENT_CATALOG.filter((entry) => entry.group === 'ai')).toHaveLength(14);
    expectTypeOf<'ai.llm.generated'>().toMatchTypeOf<AiEventName>();
    expectTypeOf<AiEventName>().toMatchTypeOf<EventName>();
  });

  it('uses no n8n. root, no duplicate, and each entry sits in the group its first segment names', () => {
    expect(names.filter((name) => name.startsWith('n8n.'))).toEqual([]);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of EVENT_CATALOG) expect(eventGroupOf(entry.name)).toBe(entry.group);
  });

  it('holds the run, node, queue, runner and worker events', () => {
    for (const name of [
      'workflow.started',
      'workflow.success',
      'workflow.failed',
      'workflow.cancelled',
      'node.started',
      'node.finished',
      'queue.job.enqueued',
      'queue.job.dequeued',
      'queue.job.completed',
      'queue.job.failed',
      'queue.job.stalled',
      'runner.task.requested',
      'runner.response.received',
      'worker.started',
      'worker.stopped',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('holds the twelve names this stage produces, and none of the dropped names', () => {
    expect(STAGE_NAMES).toHaveLength(12);
    for (const name of STAGE_NAMES) expect(names).toContain(name);
    for (const name of DROPPED) expect(names).not.toContain(name);
    expect(names).not.toContain(DESTINATION_TEST_EVENT);
    expect(DESTINATION_TEST_EVENT).toBe('destination.test');
  });
});

describe('eventGroupOf and matchesSubscription', () => {
  it('the group is the first segment', () => {
    expect(eventGroupOf('workflow.started')).toBe('workflow');
    expect(eventGroupOf('audit.user.login.success')).toBe('audit');
    expect(eventGroupOf('ai.llm.generated')).toBe('ai');
  });

  it('`*` takes everything, a group prefix its group, a single name itself', () => {
    expect(matchesSubscription('audit.user.login.success', ['*'])).toBe(true);
    expect(matchesSubscription('workflow.failed', ['workflow'])).toBe(true);
    expect(matchesSubscription('node.started', ['workflow'])).toBe(false);
    expect(matchesSubscription('audit.user.login.success', ['audit.user.login.success'])).toBe(true);
    expect(matchesSubscription('audit.user.login.failed', ['audit.user.login.success'])).toBe(false);
    expect(matchesSubscription('workflow.started', [])).toBe(false);
    expect(matchesSubscription('workflow.started', [''])).toBe(false);
  });
});

describe('parseOtlpHeaders', () => {
  it('reads k=v,k=v, trims, keeps a value that holds "="', () => {
    expect(parseOtlpHeaders(' api-key = abc , x-tenant=one=two ,')).toEqual({
      headers: { 'api-key': 'abc', 'x-tenant': 'one=two' },
      invalidEntries: [],
    });
    expect(parseOtlpHeaders('')).toEqual({ headers: {}, invalidEntries: [] });
    expect(parseOtlpHeaders(undefined)).toEqual({ headers: {}, invalidEntries: [] });
  });

  it("reports n8n's two problems by position and leaves those entries out", () => {
    const parsed = parseOtlpHeaders('good=1,novalue,=orphan,other=2');
    expect(parsed.headers).toEqual({ good: '1', other: '2' });
    expect(parsed.invalidEntries).toEqual([
      { position: 2, problem: 'missing "=" separator' },
      { position: 3, problem: 'empty key' },
    ]);
  });
});

describe('telemetry tags', () => {
  it('validateTelemetryTags: valid, empty key, duplicate key, too many, too long', () => {
    expect(TELEMETRY_TAG_LIMITS).toEqual({ max: 20, keyLength: 64, valueLength: 256 });
    expect(validateTelemetryTags([{ key: 'team', value: 'core' }])).toBeNull();
    expect(validateTelemetryTags([])).toBeNull();
    expect(validateTelemetryTags(undefined)).toBeNull();
    expect(validateTelemetryTags([{ key: '  ', value: 'x' }])).toEqual(expect.any(String));
    expect(
      validateTelemetryTags([
        { key: 'team', value: 'a' },
        { key: ' team ', value: 'b' },
      ]),
    ).toEqual(expect.any(String));
    const many = Array.from({ length: 21 }, (_, i) => ({ key: `k${i}`, value: 'v' }));
    expect(validateTelemetryTags(many)).toEqual(expect.any(String));
    expect(validateTelemetryTags(many.slice(0, 20))).toBeNull();
    expect(validateTelemetryTags([{ key: 'k'.repeat(65), value: 'v' }])).toEqual(expect.any(String));
    expect(validateTelemetryTags([{ key: 'k', value: 'v'.repeat(257) }])).toEqual(expect.any(String));
    expect(validateTelemetryTags('team=core')).toEqual(expect.any(String));
    expect(validateTelemetryTags([{ key: 'k', value: 3 }])).toEqual(expect.any(String));
  });

  it("telemetryTagsOf: a plain list (workflow, project) and n8n's node shape { tag: [...] }", () => {
    const tags: TelemetryTag[] = [{ key: 'team', value: 'core' }];
    expect(telemetryTagsOf(tags)).toEqual(tags);
    expect(
      telemetryTagsOf({
        tag: [
          { key: ' team ', value: '={{ $json.x }}' },
          { key: '', value: 'x' },
        ],
      }),
    ).toEqual([{ key: 'team', value: '={{ $json.x }}' }]);
    expect(telemetryTagsOf({})).toEqual([]);
    expect(telemetryTagsOf(null)).toEqual([]);
    expect(telemetryTagsOf('x')).toEqual([]);
  });

  it('the workflow setting, the node setting and logAiEvent have their contract types', () => {
    expectTypeOf<WorkflowSettings['customTelemetryTags']>().toEqualTypeOf<TelemetryTag[] | undefined>();
    expectTypeOf<WorkflowNode['customTelemetryTags']>().toEqualTypeOf<{ tag?: TelemetryTag[] } | undefined>();
    expectTypeOf<NonNullable<ExecuteContext['logAiEvent']>>().parameters.toEqualTypeOf<
      [AiEventName, (string | undefined)?]
    >();
    expectTypeOf<NonNullable<SupplyDataContext['logAiEvent']>>().parameters.toEqualTypeOf<
      [AiEventName, (string | undefined)?]
    >();
  });
});

describe('log destinations', () => {
  it("the breaker defaults are n8n's (5 failures in 60 s) and the DTO narrows settings by type", () => {
    expect(DEFAULT_CIRCUIT_BREAKER).toEqual({ maxFailures: 5, failureWindowMs: 60_000 });
    const destination: LogDestination = {
      id: 'd1',
      type: 'sentry',
      label: 'Errors',
      enabled: true,
      subscribedEvents: ['workflow.failed'],
      anonymizeAuditMessages: false,
      settings: { dsn: '', sendPayload: false },
    };
    if (destination.type === 'sentry') expect(destination.settings.sendPayload).toBe(false);
  });
});
