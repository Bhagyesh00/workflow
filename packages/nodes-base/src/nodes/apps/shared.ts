/** Helpers for resource/operation integrations. */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
  type NodePropertyOption,
  type ResourceLocatorMode,
} from '@workflow/workflow';
import { type HandlerResult, mapItems } from '../../utils/utilities';

export type OperationHandler = (ctx: ExecuteContext, itemIndex: number, item: Item) => Promise<HandlerResult>;

/** Dispatch every item to `handlers[resource][operation]` with per-item error isolation. */
export async function runOperations(
  ctx: ExecuteContext,
  handlers: Record<string, Record<string, OperationHandler>>,
): Promise<Item[][]> {
  return [
    await mapItems(ctx, async (i, item) => {
      const resource = ctx.getNodeParameter('resource', i) as string;
      const operation = ctx.getNodeParameter('operation', i) as string;
      const handler = handlers[resource]?.[operation];
      if (!handler) {
        throw new NodeOperationError(
          ctx.getNode(),
          `The operation "${operation}" is not supported for "${resource}"`,
          {
            itemIndex: i,
          },
        );
      }
      return handler(ctx, i, item);
    }),
  ];
}

export function resourceProperty(options: NodePropertyOption[], defaultValue: string): NodeProperty {
  return {
    displayName: 'Resource',
    name: 'resource',
    type: 'options',
    noDataExpression: true,
    default: defaultValue,
    options,
  };
}

export function operationProperty(
  resource: string,
  options: NodePropertyOption[],
  defaultValue: string,
): NodeProperty {
  return {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    default: defaultValue,
    displayOptions: { show: { resource: [resource] } },
    options,
  };
}

/** Restrict a property to resource/operation combinations. */
export function forOps(
  property: NodeProperty,
  resource: string | string[],
  operation: string | string[],
): NodeProperty {
  return {
    ...property,
    displayOptions: {
      ...property.displayOptions,
      show: {
        ...(property.displayOptions?.show ?? {}),
        resource: Array.isArray(resource) ? resource : [resource],
        operation: Array.isArray(operation) ? operation : [operation],
      },
    },
  };
}

export function returnAllProperties(
  resource: string | string[],
  operation: string | string[],
  max = 500,
): NodeProperty[] {
  return [
    forOps(
      {
        displayName: 'Return All',
        name: 'returnAll',
        type: 'boolean',
        default: false,
        description: 'Whether to return all results or only up to a limit',
      },
      resource,
      operation,
    ),
    {
      ...forOps(
        {
          displayName: 'Limit',
          name: 'limit',
          type: 'number',
          default: 50,
          typeOptions: { minValue: 1, maxValue: max },
          description: 'Max number of results to return',
        },
        resource,
        operation,
      ),
      displayOptions: {
        show: {
          resource: Array.isArray(resource) ? resource : [resource],
          operation: Array.isArray(operation) ? operation : [operation],
          returnAll: [false],
        },
      },
    },
  ];
}

/** Resource locator with list (searchable), id and optional url modes. */
export function locator(
  name: string,
  displayName: string,
  options: {
    searchListMethod?: string;
    urlRegex?: string;
    urlPlaceholder?: string;
    idPlaceholder?: string;
    required?: boolean;
    description?: string;
    extraModes?: ResourceLocatorMode[];
  } = {},
): NodeProperty {
  const modes: ResourceLocatorMode[] = [];
  if (options.searchListMethod) {
    modes.push({
      displayName: 'From List',
      name: 'list',
      type: 'list',
      placeholder: `Select a ${displayName.toLowerCase()}...`,
      typeOptions: { searchListMethod: options.searchListMethod, searchable: true },
    });
  }
  modes.push({ displayName: 'By ID', name: 'id', type: 'string', placeholder: options.idPlaceholder });
  if (options.urlRegex) {
    modes.push({
      displayName: 'By URL',
      name: 'url',
      type: 'string',
      placeholder: options.urlPlaceholder,
      extractValue: { type: 'regex', regex: options.urlRegex },
    });
  }
  modes.push(...(options.extraModes ?? []));
  return {
    displayName,
    name,
    type: 'resourceLocator',
    default: { __rl: true, mode: modes[0].name, value: '' },
    required: options.required ?? true,
    description: options.description,
    modes,
  };
}

/** Read a resource locator (or plain string) parameter and fail when it is empty. */
export function requiredId(ctx: ExecuteContext, name: string, itemIndex: number, label = name): string {
  const value = String(ctx.getNodeParameter(name, itemIndex, '', { extractValue: true }) ?? '').trim();
  if (!value)
    throw new NodeOperationError(ctx.getNode(), `${label} is required`, { itemIndex, parameter: name });
  return value;
}

export function optionalString(ctx: ExecuteContext, name: string, itemIndex: number): string | undefined {
  const value = ctx.getNodeParameter(name, itemIndex, '');
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

/** Copy only defined, non-empty values (API option bags). */
export function compact(object: DataObject): DataObject {
  return Object.fromEntries(
    Object.entries(object).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
}
