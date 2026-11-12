/**
 * P6-67 (S5 L11): a node's custom telemetry tags. `resolveTelemetryTags` trims keys, skips blank keys, evaluates each
 * value against item 0, keeps only text, number and boolean results (a null or object result is skipped with a
 * warning), bounds the count and the text length, and never throws into the run; the engine puts the result in the
 * task's `metadata.tracing`.
 */
import { TELEMETRY_TAG_LIMITS, type WorkflowNode } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { resolveTelemetryTags } from '../src';
import { connect, execute, node } from './helpers';

const tagged = (tags: Array<{ key: string; value: string }> | undefined): WorkflowNode =>
  node('Set', 'test.set', [0, 0], tags === undefined ? {} : { customTelemetryTags: { tag: tags } });

describe('resolveTelemetryTags', () => {
  it('is undefined for a node with no tags or an empty list', () => {
    expect(resolveTelemetryTags(tagged(undefined), () => 'x')).toBeUndefined();
    expect(resolveTelemetryTags(tagged([]), () => 'x')).toBeUndefined();
  });

  it('evaluates each value and trims the keys', () => {
    const seen: string[] = [];
    const out = resolveTelemetryTags(
      tagged([
        { key: '  team ', value: 'core' },
        { key: 'plan', value: '={{ $json.plan }}' },
      ]),
      (value) => {
        seen.push(value);
        return value.startsWith('=') ? 'pro' : value;
      },
    );
    expect(out).toEqual({ team: 'core', plan: 'pro' });
    expect(seen).toEqual(['core', '={{ $json.plan }}']);
  });

  it('skips a blank key without evaluating its value', () => {
    const seen: string[] = [];
    const out = resolveTelemetryTags(
      tagged([
        { key: '   ', value: 'skipped' },
        { key: '', value: 'skipped too' },
        { key: 'kept', value: 'yes' },
      ]),
      (value) => {
        seen.push(value);
        return value;
      },
    );
    expect(out).toEqual({ kept: 'yes' });
    expect(seen).toEqual(['yes']);
  });

  it('keeps text, number and boolean results; skips null and non-primitive ones with a warning', () => {
    const results: Record<string, unknown> = {
      text: 'a',
      num: 3,
      flag: false,
      nothing: null,
      missing: undefined,
      obj: { a: 1 },
      list: [1, 2],
      nan: Number.NaN,
    };
    const warned: string[] = [];
    const out = resolveTelemetryTags(
      tagged(Object.keys(results).map((key) => ({ key, value: key }))),
      (value) => results[value],
      (key) => warned.push(key),
    );
    expect(out).toEqual({ text: 'a', num: 3, flag: false });
    expect(warned.sort()).toEqual(['list', 'missing', 'nan', 'nothing', 'obj']);
  });

  it('never throws: an evaluation error skips that tag only', () => {
    const warned: string[] = [];
    const out = resolveTelemetryTags(
      tagged([
        { key: 'bad', value: 'boom' },
        { key: 'good', value: 'fine' },
      ]),
      (value) => {
        if (value === 'boom') throw new Error('expression failed');
        return value;
      },
      (key) => warned.push(key),
    );
    expect(out).toEqual({ good: 'fine' });
    expect(warned).toEqual(['bad']);
  });

  it('is undefined when every tag is skipped', () => {
    expect(resolveTelemetryTags(tagged([{ key: 'a', value: 'x' }]), () => null)).toBeUndefined();
  });

  it('bounds the number of tags and the length of a text value', () => {
    const many = Array.from({ length: TELEMETRY_TAG_LIMITS.max + 5 }, (_, i) => ({
      key: `k${i}`,
      value: 'v',
    }));
    const out = resolveTelemetryTags(tagged(many), (value) => value) ?? {};
    expect(Object.keys(out)).toHaveLength(TELEMETRY_TAG_LIMITS.max);
    const long = resolveTelemetryTags(tagged([{ key: 'big', value: 'x' }]), () => 'y'.repeat(5000)) ?? {};
    expect((long.big as string).length).toBe(TELEMETRY_TAG_LIMITS.valueLength);
  });
});

describe('the engine puts the resolved tags in the task metadata', () => {
  it('a node with tags gets metadata.tracing; a node without gets none', async () => {
    const result = await execute({
      name: 'tags',
      nodes: [
        node('Start', 'test.trigger'),
        node('Set', 'test.set', [100, 0], {
          customTelemetryTags: {
            tag: [
              { key: ' team ', value: '={{ 1 + 1 }}' },
              { key: 'area', value: 'billing' },
              { key: 'ok', value: '={{ true }}' },
              { key: 'empty', value: '={{ null }}' },
            ],
          },
        }),
        node('Plain', 'test.set', [200, 0]),
      ],
      connections: connect(['Start', 'Set'], ['Set', 'Plain']),
    }).run({ startNode: 'Start' });
    expect(result.status).toBe('success');
    const runData = result.state.resultData.runData;
    expect(runData.Set?.[0]?.metadata?.tracing).toEqual({ team: 2, area: 'billing', ok: true });
    expect(runData.Plain?.[0]?.metadata?.tracing).toBeUndefined();
    expect(runData.Start?.[0]?.metadata?.tracing).toBeUndefined();
  });
});
