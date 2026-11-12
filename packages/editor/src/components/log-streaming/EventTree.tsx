/**
 * P6-64 (L8): the Events tab: a checkbox tree grouped by `eventGroupOf` (a whole group saves its prefix, a
 * single event its name; `*` is everything), with the anonymize switch in the audit group.
 */
import { eventGroupOf, matchesSubscription } from '@workflow/workflow';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { Checkbox, Switch } from '../ui/Field';

export interface EventTreeProps {
  /** every event name a destination may subscribe to (`useEventNames`, else workflow's `EVENT_CATALOG`) */
  eventNames: string[];
  /** the destination's `subscribedEvents` (group prefixes, single names or `*`) */
  value: string[];
  onChange(next: string[]): void;
  anonymizeAuditMessages: boolean;
  onAnonymizeChange(next: boolean): void;
  disabled?: boolean;
}

/** n8n lists audit, workflow and node first */
const GROUP_ORDER = ['audit', 'workflow', 'node', 'ai', 'queue', 'runner', 'worker'];
const GROUP_WORDS: Record<string, string> = { ai: 'AI' };

function groupWord(group: string): string {
  return GROUP_WORDS[group] ?? group;
}

function GroupBox({
  label,
  checked,
  indeterminate,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  onChange(next: boolean): void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <Checkbox
      ref={ref}
      label={label}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="font-semibold"
    />
  );
}

export function EventTree({
  eventNames,
  value,
  onChange,
  anonymizeAuditMessages,
  onAnonymizeChange,
  disabled,
}: EventTreeProps): ReactNode {
  const groups = useMemo(() => {
    const byGroup = new Map<string, string[]>();
    for (const name of eventNames) {
      const group = eventGroupOf(name);
      byGroup.set(group, [...(byGroup.get(group) ?? []), name]);
    }
    const rank = (group: string) => {
      const index = GROUP_ORDER.indexOf(group);
      return index === -1 ? GROUP_ORDER.length : index;
    };
    return [...byGroup.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
  }, [eventNames]);

  const selected = new Set(eventNames.filter((name) => matchesSubscription(name, value)));
  // an entry that matches no known name (a retired event) stays as it is
  const unknown = value.filter(
    (entry) => entry !== '*' && !eventNames.some((name) => name.startsWith(entry)),
  );

  /** the shortest value for a set of names: `*`, a group prefix, or single names */
  const commit = (names: Set<string>) => {
    if (eventNames.length > 0 && eventNames.every((name) => names.has(name))) {
      onChange(['*', ...unknown]);
      return;
    }
    const next: string[] = [];
    for (const [group, members] of groups) {
      if (members.every((name) => names.has(name))) next.push(group);
      else next.push(...members.filter((name) => names.has(name)));
    }
    onChange([...next, ...unknown]);
  };

  const setNames = (names: string[], on: boolean) => {
    const next = new Set(selected);
    for (const name of names) {
      if (on) next.add(name);
      else next.delete(name);
    }
    commit(next);
  };

  const allOn = eventNames.length > 0 && eventNames.every((name) => selected.has(name));

  return (
    <div className="flex flex-col gap-3">
      <GroupBox
        label="All events"
        checked={allOn}
        indeterminate={!allOn && selected.size > 0}
        disabled={disabled}
        onChange={(on) => (on ? onChange(['*', ...unknown]) : onChange([...unknown]))}
      />
      <div className="flex max-h-[46vh] flex-col gap-3 overflow-y-auto rounded-lg border border-line p-3">
        {groups.map(([group, members]) => {
          const count = members.filter((name) => selected.has(name)).length;
          return (
            <fieldset key={group} className="flex flex-col gap-1.5">
              <legend className="sr-only">{`${groupWord(group)} events`}</legend>
              <GroupBox
                label={`All ${groupWord(group)} events`}
                checked={count === members.length}
                indeterminate={count > 0 && count < members.length}
                disabled={disabled}
                onChange={(on) => setNames(members, on)}
              />
              {group === 'audit' && (
                <div className="ml-6 flex items-center gap-2 text-sm text-ink-2">
                  <Switch
                    size="sm"
                    checked={anonymizeAuditMessages}
                    onChange={onAnonymizeChange}
                    label="Anonymize audit messages"
                    disabled={disabled}
                  />
                  <span>Anonymize audit messages (names and emails are sent as *)</span>
                </div>
              )}
              <div className="ml-6 grid gap-1 sm:grid-cols-2">
                {members.map((name) => (
                  <Checkbox
                    key={name}
                    label={name}
                    checked={selected.has(name)}
                    disabled={disabled}
                    onChange={(e) => setNames([name], e.target.checked)}
                    className="font-mono text-xs"
                  />
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}
