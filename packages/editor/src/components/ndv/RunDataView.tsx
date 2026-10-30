/**
 * Item data in three views: table, JSON and schema. In the input pane every field can be
 * dragged onto a parameter, which inserts `{{ $json.path }}` (or `$('Node')...` for non-direct parents).
 */
import type { Item } from '@workflow/workflow';
import { ChevronDown, ChevronRight, FileBox } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import {
  accessPath,
  cellText,
  fieldExpression,
  inferSchema,
  kindOf,
  type SchemaField,
  tableColumns,
  type ValueKind,
} from '../../lib/data';
import { FIELD_DRAG_TYPE } from '../parameters/context';
import { cx } from '../ui/cx';

export type DataViewMode = 'table' | 'json' | 'schema';

export interface DragSource {
  /** set when the data is not from the node's direct parent (expressions then use `$('Node')`) */
  fromNode?: string;
}

const PAGE = 50;

function dragProps(path: Array<string | number>, source: DragSource | undefined) {
  if (!source) return {};
  const expression = fieldExpression(path, source.fromNode);
  return {
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      event.dataTransfer.setData(FIELD_DRAG_TYPE, expression);
      event.dataTransfer.setData('text/plain', expression);
      event.dataTransfer.effectAllowed = 'copy';
    },
    title: `Drag onto a parameter to use ${expression}`,
    className: 'cursor-grab active:cursor-grabbing',
  };
}

const kindColors: Record<ValueKind, string> = {
  string: 'text-ok',
  number: 'text-warn',
  boolean: 'text-pin',
  null: 'text-ink-3',
  undefined: 'text-ink-3',
  array: 'text-brand',
  object: 'text-brand',
};

const kindLabels: Record<ValueKind, string> = {
  string: 'Aa',
  number: '#',
  boolean: '◐',
  null: '∅',
  undefined: '∅',
  array: '[ ]',
  object: '{ }',
};

function TableView({ items, source }: { items: Item[]; source?: DragSource }) {
  const [limit, setLimit] = useState(PAGE);
  const columns = useMemo(() => tableColumns(items), [items]);
  if (!columns.length) {
    return (
      <p className="p-3 text-sm text-ink-3">
        {items.length} item{items.length === 1 ? '' : 's'} without fields
      </p>
    );
  }
  return (
    <div className="wf-scroll h-full overflow-auto">
      <table className="min-w-full border-separate border-spacing-0 text-xs">
        <thead className="sticky top-0 z-10 bg-surface-2">
          <tr>
            <th className="border-b border-line px-2 py-1.5 text-left font-semibold text-ink-3">#</th>
            {columns.map((column) => {
              const drag = dragProps([column], source);
              return (
                <th
                  key={column}
                  className="border-b border-l border-line px-2 py-1.5 text-left font-semibold whitespace-nowrap text-ink-2"
                >
                  <span
                    {...drag}
                    className={cx(
                      'rounded px-1 py-0.5',
                      drag.className,
                      source && 'hover:bg-brand-soft hover:text-brand',
                    )}
                  >
                    {column}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {items.slice(0, limit).map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional item indexes
            <tr key={index} className="hover:bg-surface-2">
              <td className="border-b border-line px-2 py-1.5 align-top text-ink-3">{index + 1}</td>
              {columns.map((column) => {
                const value = item.json?.[column];
                return (
                  <td
                    key={column}
                    className="max-w-72 border-b border-l border-line px-2 py-1.5 align-top font-mono break-words text-ink"
                  >
                    <span
                      className={cx(value === null && 'text-ink-3', typeof value === 'number' && 'text-warn')}
                    >
                      {cellText(value)}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {items.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((l) => l + PAGE)}
          className="m-2 text-xs font-semibold text-brand"
        >
          Show {Math.min(PAGE, items.length - limit)} more of {items.length}
        </button>
      )}
    </div>
  );
}

function JsonNode({
  name,
  value,
  path,
  source,
  depth,
}: {
  name?: string | number;
  value: unknown;
  path: Array<string | number>;
  source?: DragSource;
  depth: number;
}) {
  const [open, setOpen] = useState(depth < 3);
  const kind = kindOf(value);
  const label =
    name === undefined ? null : (
      <span
        {...(path.length ? dragProps(path, source) : {})}
        className={cx('text-pin', source && path.length && 'cursor-grab hover:underline')}
      >
        {typeof name === 'number' ? name : JSON.stringify(name)}
        <span className="text-ink-3">: </span>
      </span>
    );
  if (kind === 'object' || kind === 'array') {
    const entries: Array<[string | number, unknown]> =
      kind === 'array' ? (value as unknown[]).map((v, i) => [i, v]) : Object.entries(value as object);
    const brackets = kind === 'array' ? ['[', ']'] : ['{', '}'];
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center text-ink-3 hover:text-ink"
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
        {label}
        <span className="text-ink-2">{brackets[0]}</span>
        {!open && (
          <span className="text-ink-3">
            {' '}
            {entries.length} {kind === 'array' ? 'items' : 'keys'} {brackets[1]}
          </span>
        )}
        {open && (
          <>
            <div className="ml-4 border-l border-line pl-2">
              {entries.slice(0, 200).map(([k, v]) => (
                <JsonNode
                  key={String(k)}
                  name={k}
                  value={v}
                  path={[...path, k]}
                  source={source}
                  depth={depth + 1}
                />
              ))}
              {entries.length > 200 && <div className="text-ink-3">… {entries.length - 200} more</div>}
            </div>
            <span className="text-ink-2">{brackets[1]}</span>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="pl-3">
      {label}
      <span className={kindColors[kind]}>{kind === 'string' ? JSON.stringify(value) : String(value)}</span>
    </div>
  );
}

function JsonView({ items, source }: { items: Item[]; source?: DragSource }) {
  const [limit, setLimit] = useState(PAGE);
  return (
    <div className="wf-scroll h-full overflow-auto p-2 font-mono text-xs leading-5">
      {items.slice(0, limit).map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: items are positional
        <div key={index} className="mb-1">
          <JsonNode value={item.json ?? {}} path={[]} source={source} depth={0} />
        </div>
      ))}
      {items.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((l) => l + PAGE)}
          className="font-sans text-xs font-semibold text-brand"
        >
          Show more
        </button>
      )}
    </div>
  );
}

function SchemaRow({ field, source, depth }: { field: SchemaField; source?: DragSource; depth: number }) {
  const [open, setOpen] = useState(true);
  const drag = dragProps(field.path, source);
  return (
    <li>
      <div className="flex items-center gap-1.5 py-0.5" style={{ paddingLeft: depth * 14 }}>
        {field.children.length ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? 'Collapse' : 'Expand'}
            className="text-ink-3"
          >
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        ) : (
          <span className="w-[11px]" />
        )}
        <span
          {...drag}
          className={cx(
            'inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-1.5 py-0.5',
            source && 'cursor-grab hover:border-brand hover:text-brand',
          )}
          data-path={accessPath(field.path)}
        >
          <span className={cx('font-mono text-2xs', kindColors[field.kind])} title={field.kind}>
            <span aria-hidden="true">{kindLabels[field.kind]}</span>
            <span className="sr-only">{field.kind}</span>
          </span>
          <span className="text-xs font-semibold">{field.key}</span>
        </span>
        {field.example !== undefined && (
          <span className="truncate font-mono text-xs text-ink-3">{field.example}</span>
        )}
      </div>
      {open && field.children.length > 0 && (
        <ul>
          {field.children.map((child) => (
            <SchemaRow key={child.key} field={child} source={source} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SchemaView({ items, source }: { items: Item[]; source?: DragSource }) {
  const schema = useMemo(() => inferSchema(items), [items]);
  if (!schema.length) return <p className="p-3 text-sm text-ink-3">Items have no fields</p>;
  return (
    <ul className="wf-scroll h-full overflow-auto p-2" aria-label="Data schema">
      {schema.map((field) => (
        <SchemaRow key={field.key} field={field} source={source} depth={0} />
      ))}
    </ul>
  );
}

function BinaryStrip({ items }: { items: Item[] }) {
  const files = items.flatMap((item, i) =>
    Object.entries(item.binary ?? {}).map(([key, b]) => ({
      key: `${i}-${key}`,
      item: i,
      property: key,
      binary: b,
    })),
  );
  if (!files.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 border-b border-line px-2 py-1.5">
      {files.slice(0, 12).map((f) => (
        <span
          key={f.key}
          className="inline-flex items-center gap-1 rounded-md bg-surface-3 px-1.5 py-0.5 text-2xs text-ink-2"
          title={f.binary.mimeType}
        >
          <FileBox size={11} />
          <span className="font-semibold text-ink">{f.binary.fileName ?? f.property}</span>
          <span>{f.binary.mimeType}</span>
        </span>
      ))}
    </div>
  );
}

export function RunDataView({
  items,
  mode,
  source,
  empty,
}: {
  items: Item[];
  mode: DataViewMode;
  source?: DragSource;
  empty?: ReactNode;
}) {
  if (!items.length) return <>{empty}</>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <BinaryStrip items={items} />
      <div className="min-h-0 flex-1">
        {mode === 'table' && <TableView items={items} source={source} />}
        {mode === 'json' && <JsonView items={items} source={source} />}
        {mode === 'schema' && <SchemaView items={items} source={source} />}
      </div>
    </div>
  );
}
