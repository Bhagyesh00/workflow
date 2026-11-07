/**
 * "Test a tool": asks for the values the model would pass to a tool node (P5-76). `args` holds the tool's `$fromAI`
 * scan; the caller opens no modal when the scan is empty. The values are data: they go out as typed here and nothing
 * reads them as expressions.
 */
import type { DataObject, FromAiArgument } from '@workflow/workflow';
import { type FormEvent, type ReactElement, useEffect, useId, useState } from 'react';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { FormField, Switch, TextArea, TextInput } from '../ui/Field';

const VALUE_MISSING = 'Enter a value';
const NOT_A_NUMBER = 'Enter a number';
const JSON_RULE = 'Value must be a non-empty object or a non-empty array';

export interface ToolTestModalProps {
  open: boolean;
  nodeName: string;
  /** the node that normally calls the tool, for the prompt text; empty when nothing calls it */
  parentName: string;
  args: FromAiArgument[];
  onExecute: (query: DataObject) => void;
  onCancel: () => void;
}

type FieldValue = string | boolean;

function initialValue({ type, defaultValue }: FromAiArgument): FieldValue {
  if (type === 'boolean') return defaultValue === true;
  if (defaultValue === undefined) return '';
  return typeof defaultValue === 'string' ? defaultValue : JSON.stringify(defaultValue);
}

function isNonEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && typeof value === 'object' && Object.keys(value).length > 0;
}

/** one field as the value the tool gets, `omit` when it should fall back to its default, or the problem with it */
function readField(
  arg: FromAiArgument,
  raw: FieldValue,
): { value: unknown } | { omit: true } | { error: string } {
  if (typeof raw === 'boolean') return { value: raw };
  if (raw.trim() === '') return arg.defaultValue === undefined ? { error: VALUE_MISSING } : { omit: true };
  if (arg.type === 'number') {
    const value = Number(raw);
    return Number.isFinite(value) ? { value } : { error: NOT_A_NUMBER };
  }
  if (arg.type !== 'json') return { value: raw };
  try {
    const value: unknown = JSON.parse(raw);
    return isNonEmptyContainer(value) ? { value } : { error: JSON_RULE };
  } catch {
    return { error: JSON_RULE };
  }
}

export function ToolTestModal({
  open,
  nodeName,
  parentName,
  args,
  onExecute,
  onCancel,
}: ToolTestModalProps): ReactElement {
  const formId = useId();
  // by position, so a key such as `__proto__` is an ordinary field
  const [values, setValues] = useState<FieldValue[]>(() => args.map(initialValue));
  const [errors, setErrors] = useState<Array<string | undefined>>([]);

  useEffect(() => {
    if (!open) return;
    setValues(args.map(initialValue));
    setErrors([]);
  }, [open, args]);

  const change = (index: number, value: FieldValue) => {
    setValues((current) => current.map((old, i) => (i === index ? value : old)));
    setErrors((current) => current.map((old, i) => (i === index ? undefined : old)));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const read = args.map((arg, index) => readField(arg, values[index] ?? initialValue(arg)));
    const problems = read.map((field) => ('error' in field ? field.error : undefined));
    setErrors(problems);
    if (problems.some(Boolean)) return;
    // fromEntries makes own properties, so a key named `__proto__` sets no prototype
    onExecute(
      Object.fromEntries(
        args.flatMap((arg, index) => {
          const field = read[index];
          return 'value' in field ? [[arg.key, field.value]] : [];
        }),
      ),
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={`Test ${nodeName}`}
      description={
        parentName
          ? `Provide the data that would normally come from the "${parentName}" node`
          : 'Provide the data the tool needs'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId}>
            Execute step
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
        {args.map((arg, index) => {
          const value = values[index] ?? initialValue(arg);
          return (
            <FormField
              key={arg.key}
              label={arg.key}
              hint={arg.description}
              error={errors[index]}
              required={arg.type !== 'boolean' && arg.defaultValue === undefined}
            >
              {(id) =>
                arg.type === 'boolean' ? (
                  <Switch
                    id={id}
                    label={arg.key}
                    checked={value === true}
                    onChange={(next) => change(index, next)}
                  />
                ) : arg.type === 'json' ? (
                  <TextArea
                    id={id}
                    rows={4}
                    className="font-mono"
                    value={String(value)}
                    onChange={(event) => change(index, event.target.value)}
                  />
                ) : (
                  <TextInput
                    id={id}
                    type={arg.type === 'number' ? 'number' : 'text'}
                    step={arg.type === 'number' ? 'any' : undefined}
                    value={String(value)}
                    onChange={(event) => change(index, event.target.value)}
                  />
                )
              }
            </FormField>
          );
        })}
      </form>
    </Dialog>
  );
}
