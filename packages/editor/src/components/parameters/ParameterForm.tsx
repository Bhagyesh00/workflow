/**
 * Renders node (and credential) parameters from their schema. Visibility follows
 * `isParameterDisplayed` (incl. `@version` and `/root` paths); every value type can switch
 * between a fixed value and an expression.
 */
import {
  isParameterDisplayed,
  type NodeParameters,
  type NodeProperty,
  type NodePropertyCollection,
} from '@workflow/workflow';
import { ArrowDown, ArrowUp, Info, Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import type { ParameterPath } from '../../lib/workflow-ops';
import { Button } from '../ui/Button';
import { cx } from '../ui/cx';
import { Menu } from '../ui/Menu';
import { AssignmentInput } from './AssignmentInput';
import { EXPRESSION_CAPABLE, FIELD_DRAG_TYPE, isExpressionValue, useParameterContext } from './context';
import { ExpressionInput } from './ExpressionInput';
import { FilterInput } from './FilterInput';
import {
  BooleanInput,
  ButtonInput,
  CodeInput,
  ColorInput,
  CredentialsSelectInput,
  DateTimeInput,
  JsonInput,
  MultiOptionsInput,
  NoticeInput,
  NumberInput,
  OptionsInput,
  StringInput,
} from './inputs';
import { ResourceLocatorInput } from './ResourceLocatorInput';

function cloneDefault(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function isCollection(option: unknown): option is NodePropertyCollection {
  return Boolean(
    option && typeof option === 'object' && Array.isArray((option as NodePropertyCollection).values),
  );
}

function isProperty(option: unknown): option is NodeProperty {
  return Boolean(option && typeof option === 'object' && 'type' in option && 'name' in option);
}

/** sibling values with defaults filled in, for displayOptions evaluation */
export function withDefaults(properties: NodeProperty[], values: NodeParameters): NodeParameters {
  const merged: NodeParameters = { ...values };
  const defaulted = (prop: NodeProperty) => prop.type !== 'notice' && prop.type !== 'button';
  // several properties may share a name (one `operation` per resource): the default comes from the one shown (R50)
  for (const prop of properties) {
    if (!(prop.name in merged) && defaulted(prop) && isParameterDisplayed(prop.displayOptions, merged))
      merged[prop.name] = prop.default;
  }
  for (const prop of properties) {
    if (!(prop.name in merged) && defaulted(prop)) merged[prop.name] = prop.default;
  }
  return merged;
}

/** Converts a fixed value into an expression and back. */
export function toExpression(value: unknown): string {
  if (isExpressionValue(value)) return value;
  if (value === undefined || value === null) return '=';
  if (typeof value === 'object') return `=${JSON.stringify(value)}`;
  return `=${String(value)}`;
}

export function fromExpression(expression: string, prop: NodeProperty): unknown {
  const raw = expression.slice(1);
  if (raw.includes('{{')) return cloneDefault(prop.default);
  switch (prop.type) {
    case 'number': {
      const n = Number(raw);
      return raw.trim() === '' || Number.isNaN(n) ? cloneDefault(prop.default) : n;
    }
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : cloneDefault(prop.default);
    case 'multiOptions':
    case 'resourceLocator':
      return cloneDefault(prop.default);
    default:
      return raw;
  }
}

export function ParameterList({
  properties,
  values,
  path,
  filter,
}: {
  properties: NodeProperty[];
  values: NodeParameters;
  path: ParameterPath;
  /** e.g. hide node settings in the parameters tab */
  filter?: (prop: NodeProperty) => boolean;
}) {
  const ctx = useParameterContext();
  const siblings = withDefaults(properties, values);
  const visible = properties.filter(
    (prop) =>
      prop.type !== 'hidden' &&
      (!filter || filter(prop)) &&
      isParameterDisplayed(prop.displayOptions, siblings, {
        nodeVersion: ctx.node.typeVersion,
        rootParams: withDefaults(ctx.description?.properties ?? properties, ctx.rootValues),
      }),
  );
  return (
    <div className="flex flex-col gap-4">
      {visible.map((prop) => (
        <ParameterField
          key={`${prop.name}-${prop.displayName}`}
          prop={prop}
          value={prop.name in values ? values[prop.name] : prop.default}
          path={[...path, prop.name]}
        />
      ))}
    </div>
  );
}

function FieldLabel({ prop, id, right }: { prop: NodeProperty; id: string; right?: ReactNode }) {
  return (
    <div className="flex min-h-6 items-center gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {prop.displayName}
        {prop.required && <span className="ml-0.5 text-err">*</span>}
      </label>
      {prop.description && (
        <span title={prop.description} className="text-ink-3">
          <Info size={12} aria-label={prop.description} />
        </span>
      )}
      <span className="ml-auto">{right}</span>
    </div>
  );
}

function ModeToggle({
  expression,
  onToggle,
  label,
}: {
  expression: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <fieldset
      aria-label={`${label} value mode`}
      className="inline-flex rounded-md border-0 bg-surface-3 p-0.5 text-2xs font-semibold"
    >
      <button
        type="button"
        aria-pressed={!expression}
        onClick={() => expression && onToggle()}
        className={cx(
          'rounded px-1.5 py-0.5',
          !expression ? 'bg-surface text-ink shadow-card' : 'text-ink-2',
        )}
      >
        Fixed
      </button>
      <button
        type="button"
        aria-pressed={expression}
        onClick={() => !expression && onToggle()}
        className={cx(
          'rounded px-1.5 py-0.5',
          expression ? 'bg-surface text-brand shadow-card' : 'text-ink-2',
        )}
      >
        Expression
      </button>
    </fieldset>
  );
}

export function ParameterField({
  prop,
  value,
  path,
  onRemove,
}: {
  prop: NodeProperty;
  value: unknown;
  path: ParameterPath;
  onRemove?: () => void;
}) {
  const ctx = useParameterContext();
  const id = useId();
  const [dragOver, setDragOver] = useState(false);
  const onChange = (next: unknown) => ctx.onChange(path, next);

  if (prop.type === 'hidden') return null;
  if (prop.type === 'notice') return <NoticeInput prop={prop} />;
  if (prop.type === 'button') return <ButtonInput prop={prop} />;

  const canExpress = ctx.allowExpressions && !prop.noDataExpression && EXPRESSION_CAPABLE.has(prop.type);
  const rlExpression =
    prop.type === 'resourceLocator' &&
    value &&
    typeof value === 'object' &&
    isExpressionValue((value as { value?: unknown }).value);
  const isExpr = canExpress && (isExpressionValue(value) || Boolean(rlExpression));

  const toggle = () => {
    if (prop.type === 'resourceLocator') {
      const rl = (value && typeof value === 'object' ? value : { __rl: true, mode: 'id', value: '' }) as {
        value?: unknown;
      };
      const inner = rl.value;
      onChange({ ...rl, value: isExpressionValue(inner) ? inner.slice(1) : toExpression(inner ?? '') });
      return;
    }
    onChange(isExpr ? fromExpression(String(value), prop) : toExpression(value));
  };

  const removeButton = onRemove && !ctx.readOnly && (
    <button
      type="button"
      onClick={onRemove}
      aria-label={`Remove ${prop.displayName}`}
      title={`Remove ${prop.displayName}`}
      className="grid size-6 place-items-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-err"
    >
      <Trash2 size={13} />
    </button>
  );

  let input: ReactNode;
  if (isExpr && prop.type !== 'resourceLocator') {
    input = (
      <ExpressionInput
        value={String(value)}
        onChange={onChange}
        ariaLabel={prop.displayName}
        rows={prop.type === 'json' ? 4 : (prop.typeOptions?.rows ?? 1)}
      />
    );
  } else {
    const common = { prop, value, onChange, id };
    switch (prop.type) {
      case 'string':
        input = <StringInput {...common} />;
        break;
      case 'number':
        input = <NumberInput {...common} />;
        break;
      case 'boolean':
        input = <BooleanInput {...common} />;
        break;
      case 'options':
        input = <OptionsInput {...common} />;
        break;
      case 'multiOptions':
        input = <MultiOptionsInput {...common} />;
        break;
      case 'json':
        input = <JsonInput {...common} />;
        break;
      case 'code':
        input = <CodeInput {...common} />;
        break;
      case 'color':
        input = <ColorInput {...common} />;
        break;
      case 'dateTime':
        input = <DateTimeInput {...common} />;
        break;
      case 'credentialsSelect':
        input = <CredentialsSelectInput {...common} />;
        break;
      case 'resourceLocator':
        input = <ResourceLocatorInput {...common} />;
        break;
      case 'filter':
        input = <FilterInput {...common} />;
        break;
      case 'assignmentCollection':
        input = <AssignmentInput {...common} />;
        break;
      case 'collection':
        input = <CollectionInput prop={prop} value={value} path={path} />;
        break;
      case 'fixedCollection':
        input = <FixedCollectionInput prop={prop} value={value} path={path} />;
        break;
      default:
        input = <p className="text-xs text-ink-3">Unsupported parameter type “{String(prop.type)}”</p>;
    }
  }

  const acceptsDrop = canExpress && !ctx.readOnly && prop.type !== 'resourceLocator';
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop target for fields dragged from the input pane; typing an expression is the keyboard path
    <div
      className={cx(
        'flex flex-col gap-1.5 rounded-lg transition-shadow',
        dragOver && 'ring-2 ring-brand ring-offset-4 ring-offset-surface',
      )}
      data-parameter={prop.name}
      onDragOver={(event) => {
        if (!acceptsDrop || !event.dataTransfer.types.includes(FIELD_DRAG_TYPE)) return;
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        setDragOver(false);
        if (!acceptsDrop) return;
        const dropped = event.dataTransfer.getData(FIELD_DRAG_TYPE);
        if (!dropped) return;
        event.preventDefault();
        onChange(isExpressionValue(value) ? `${value}${dropped}` : `=${dropped}`);
      }}
    >
      {prop.type === 'boolean' && !isExpr ? (
        <div className="flex items-center gap-3">
          <BooleanInput prop={prop} value={value} onChange={onChange} id={id} />
          <label htmlFor={id} className="text-sm font-semibold text-ink">
            {prop.displayName}
          </label>
          {prop.description && (
            <span title={prop.description} className="text-ink-3">
              <Info size={12} aria-label={prop.description} />
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            {canExpress && !ctx.readOnly && (
              <ModeToggle expression={false} onToggle={toggle} label={prop.displayName} />
            )}
            {removeButton}
          </span>
        </div>
      ) : (
        <>
          <FieldLabel
            prop={prop}
            id={id}
            right={
              <span className="flex items-center gap-1">
                {canExpress && !ctx.readOnly && (
                  <ModeToggle expression={isExpr} onToggle={toggle} label={prop.displayName} />
                )}
                {removeButton}
              </span>
            }
          />
          {input}
        </>
      )}
      {prop.hint && <p className="text-xs text-ink-3">{prop.hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// collection: optional settings added one by one
// ---------------------------------------------------------------------------------------------

function CollectionInput({ prop, value, path }: { prop: NodeProperty; value: unknown; path: ParameterPath }) {
  const ctx = useParameterContext();
  const values = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as NodeParameters;
  const options = (prop.options ?? []).filter(isProperty);
  const siblings = withDefaults(options, values);
  const available = options.filter(
    (o) =>
      !(o.name in values) &&
      isParameterDisplayed(o.displayOptions, siblings, {
        nodeVersion: ctx.node.typeVersion,
        rootParams: ctx.rootValues,
      }),
  );
  const set = options.filter((o) => o.name in values);
  return (
    <div className="flex flex-col gap-3">
      {set.length > 0 && (
        <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface-2 p-3">
          {set.map((option) => (
            <ParameterField
              key={option.name}
              prop={option}
              value={values[option.name]}
              path={[...path, option.name]}
              onRemove={() => ctx.onChange([...path, option.name], undefined)}
            />
          ))}
        </div>
      )}
      {set.length === 0 && <p className="text-xs text-ink-3">No {prop.displayName.toLowerCase()} set</p>}
      {!ctx.readOnly && available.length > 0 && (
        <Menu
          align="start"
          trigger={(t) => (
            <Button
              size="sm"
              variant="subtle"
              icon={<Plus size={13} />}
              onClick={t.toggle}
              aria-expanded={t['aria-expanded']}
              aria-haspopup="menu"
            >
              {prop.placeholder ?? 'Add option'}
            </Button>
          )}
          items={available.map((o) => ({
            key: o.name,
            label: o.displayName,
            onSelect: () => ctx.onChange([...path, o.name], cloneDefault(o.default)),
          }))}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// fixedCollection: named groups of fields, optionally repeatable and sortable
// ---------------------------------------------------------------------------------------------

function defaultsFor(group: NodePropertyCollection): NodeParameters {
  const entry: NodeParameters = {};
  for (const p of group.values) {
    if (p.type !== 'notice' && p.type !== 'button') entry[p.name] = cloneDefault(p.default);
  }
  return entry;
}

function FixedCollectionInput({
  prop,
  value,
  path,
}: {
  prop: NodeProperty;
  value: unknown;
  path: ParameterPath;
}) {
  const ctx = useParameterContext();
  const values = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<
    string,
    unknown
  >;
  const groups = (prop.options ?? []).filter(isCollection);
  const multiple = Boolean(prop.typeOptions?.multipleValues);
  const sortable = Boolean(prop.typeOptions?.sortable) && multiple;
  const addable = groups.filter((g) => multiple || values[g.name] === undefined);
  const buttonText =
    prop.typeOptions?.multipleValueButtonText ?? prop.placeholder ?? `Add ${prop.displayName.toLowerCase()}`;

  const addGroup = (group: NodePropertyCollection) => {
    if (multiple) {
      const list = Array.isArray(values[group.name]) ? (values[group.name] as unknown[]) : [];
      ctx.onChange([...path, group.name], [...list, defaultsFor(group)]);
    } else {
      ctx.onChange([...path, group.name], defaultsFor(group));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => {
        const groupValue = values[group.name];
        if (groupValue === undefined) return null;
        const entries = multiple
          ? Array.isArray(groupValue)
            ? (groupValue as NodeParameters[])
            : []
          : [groupValue as NodeParameters];
        return (
          <fieldset key={group.name} className="flex flex-col gap-2">
            {groups.length > 1 && (
              <legend className="mb-1 text-xs font-semibold text-ink-2">{group.displayName}</legend>
            )}
            {entries.map((entry, index) => {
              const entryPath = multiple ? [...path, group.name, index] : [...path, group.name];
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: entries are positional; the index is their identity
                  key={index}
                  className="relative rounded-xl border border-line bg-surface-2 p-3 pr-9"
                  data-testid={`fixed-collection-entry-${group.name}`}
                >
                  <ParameterList properties={group.values} values={entry ?? {}} path={entryPath} />
                  {!ctx.readOnly && (
                    <div className="absolute top-2 right-1.5 flex flex-col gap-0.5">
                      <button
                        type="button"
                        aria-label={`Remove ${group.displayName} ${index + 1}`}
                        title="Remove"
                        className="grid size-6 place-items-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-err"
                        onClick={() => {
                          if (multiple) {
                            const next = entries.filter((_, i) => i !== index);
                            ctx.onChange([...path, group.name], next.length ? next : undefined);
                          } else ctx.onChange([...path, group.name], undefined);
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                      {sortable && index > 0 && (
                        <button
                          type="button"
                          aria-label={`Move ${group.displayName} ${index + 1} up`}
                          title="Move up"
                          className="grid size-6 place-items-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink"
                          onClick={() => {
                            const next = [...entries];
                            [next[index - 1], next[index]] = [next[index], next[index - 1]];
                            ctx.onChange([...path, group.name], next);
                          }}
                        >
                          <ArrowUp size={13} />
                        </button>
                      )}
                      {sortable && index < entries.length - 1 && (
                        <button
                          type="button"
                          aria-label={`Move ${group.displayName} ${index + 1} down`}
                          title="Move down"
                          className="grid size-6 place-items-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink"
                          onClick={() => {
                            const next = [...entries];
                            [next[index + 1], next[index]] = [next[index], next[index + 1]];
                            ctx.onChange([...path, group.name], next);
                          }}
                        >
                          <ArrowDown size={13} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </fieldset>
        );
      })}
      {!ctx.readOnly && addable.length > 0 && (
        <div>
          {addable.length === 1 ? (
            <Button size="sm" variant="subtle" icon={<Plus size={13} />} onClick={() => addGroup(addable[0])}>
              {groups.length > 1 ? `Add ${addable[0].displayName.toLowerCase()}` : buttonText}
            </Button>
          ) : (
            <Menu
              align="start"
              trigger={(t) => (
                <Button
                  size="sm"
                  variant="subtle"
                  icon={<Plus size={13} />}
                  onClick={t.toggle}
                  aria-expanded={t['aria-expanded']}
                  aria-haspopup="menu"
                >
                  {buttonText}
                </Button>
              )}
              items={addable.map((g) => ({ key: g.name, label: g.displayName, onSelect: () => addGroup(g) }))}
            />
          )}
        </div>
      )}
    </div>
  );
}
