/** The parameters of "Send and Wait for Response", shared by the nodes that offer it. */
import type { NodeProperty, WebhookDescription } from '@workflow/workflow';
import { formFieldsProperty } from '../../nodes/core/form/fields';
import { timeUnitOptions } from '../../nodes/core/wait-limit';

export const SEND_AND_WAIT = 'sendAndWait';
export const SEND_AND_WAIT_OPERATION = {
  name: 'Send and Wait for Response',
  value: SEND_AND_WAIT,
  action: 'Send a message and wait for response',
};

/** after the node's id on the resume URL: a link opens only while the run stands at that node */
export const ANSWER_PATH = 'answer';

/** the page (GET) and the answer (GET with `approved`, or POST) on the resume URL of the waiting run */
export const sendAndWaitWebhooks: WebhookDescription[] = (['GET', 'POST'] as const).map((httpMethod) => ({
  name: 'default',
  httpMethod,
  path: ANSWER_PATH,
  isFullPath: false,
  restartWebhook: true,
  responseMode: 'onReceived',
}));

export const DEFAULT_APPROVE_LABEL = 'Approve';
export const DEFAULT_DECLINE_LABEL = 'Decline';
export const DEFAULT_RESPOND_LABEL = 'Respond';
export const DEFAULT_SUBMIT_LABEL = 'Submit';

type Show = Record<string, unknown[]>;

/** the same property, shown only where `show` holds as well */
function shownWhen(property: NodeProperty, show: Show): NodeProperty {
  return {
    ...property,
    displayOptions: {
      ...property.displayOptions,
      show: { ...(property.displayOptions?.show ?? {}), ...show },
    },
  };
}

const buttonStyleOptions = [
  { name: 'Primary', value: 'primary' },
  { name: 'Secondary', value: 'secondary' },
];

const limitWaitTimeOption: NodeProperty = {
  displayName: 'Limit Wait Time',
  name: 'limitWaitTime',
  type: 'fixedCollection',
  default: { values: { limitType: 'afterTimeInterval', resumeAmount: 45, resumeUnit: 'minutes' } },
  description: 'Sets a time limit after which the workflow resumes by itself',
  options: [
    {
      displayName: 'Values',
      name: 'values',
      values: [
        {
          displayName: 'Limit Type',
          name: 'limitType',
          type: 'options',
          default: 'afterTimeInterval',
          options: [
            { name: 'After Time Interval', value: 'afterTimeInterval' },
            { name: 'At Specified Time', value: 'atSpecifiedTime' },
          ],
        },
        {
          displayName: 'Amount',
          name: 'resumeAmount',
          type: 'number',
          default: 45,
          typeOptions: { minValue: 0, numberPrecision: 2 },
          displayOptions: { show: { limitType: ['afterTimeInterval'] } },
        },
        {
          displayName: 'Unit',
          name: 'resumeUnit',
          type: 'options',
          default: 'minutes',
          options: timeUnitOptions,
          displayOptions: { show: { limitType: ['afterTimeInterval'] } },
        },
        {
          displayName: 'Max Date and Time',
          name: 'maxDateAndTime',
          type: 'dateTime',
          default: '',
          displayOptions: { show: { limitType: ['atSpecifiedTime'] } },
        },
      ],
    },
  ],
};

const pageOptions: NodeProperty[] = [
  {
    displayName: 'Message Button Label',
    name: 'messageButtonLabel',
    type: 'string',
    default: DEFAULT_RESPOND_LABEL,
    description: 'The label of the button in the message that opens the page',
  },
  {
    displayName: 'Response Form Title',
    name: 'responseFormTitle',
    type: 'string',
    default: '',
    description: 'The title of the page where the person answers',
  },
  {
    displayName: 'Response Form Description',
    name: 'responseFormDescription',
    type: 'string',
    default: '',
    typeOptions: { rows: 2 },
    description:
      'Shown under the message on that page. HTML is allowed; scripts, styles and inputs are removed.',
  },
  {
    displayName: 'Response Form Button Label',
    name: 'responseFormButtonLabel',
    type: 'string',
    default: DEFAULT_SUBMIT_LABEL,
  },
];

const customCssOption: NodeProperty = {
  displayName: 'Response Form Custom Style',
  name: 'responseFormCustomCss',
  type: 'string',
  default: '',
  typeOptions: { rows: 4 },
  description: 'CSS for that page. Imports, URLs and scripts are removed.',
};

const optionsCollection = (options: NodeProperty[]): NodeProperty => ({
  displayName: 'Options',
  name: 'options',
  type: 'collection',
  default: {},
  placeholder: 'Add option',
  options,
});

/**
 * The parameters from the message to the options. `show` names where they appear (the resource
 * and operation of the node) and is added to every property.
 */
export function sendAndWaitProperties(show: Show): NodeProperty[] {
  const forType = (type: string): Show => ({ ...show, responseType: [type] });
  return [
    shownWhen(
      {
        displayName: 'Message',
        name: 'message',
        type: 'string',
        default: '',
        required: true,
        typeOptions: { rows: 4 },
        description: 'What the person is asked',
      },
      show,
    ),
    shownWhen(
      {
        displayName: 'Response Type',
        name: 'responseType',
        type: 'options',
        default: 'approval',
        noDataExpression: true,
        options: [
          { name: 'Approval', value: 'approval', description: 'Approve or decline from the message' },
          { name: 'Free Text', value: 'freeText', description: 'A text box on a page' },
          { name: 'Custom Form', value: 'customForm', description: 'Your own form elements on a page' },
        ],
      },
      show,
    ),
    shownWhen(
      {
        displayName: 'Type of Approval',
        name: 'approvalOptions',
        type: 'fixedCollection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Values',
            name: 'values',
            values: [
              {
                displayName: 'Type of Approval',
                name: 'approvalType',
                type: 'options',
                default: 'single',
                options: [
                  { name: 'Approve Only', value: 'single' },
                  { name: 'Approve and Decline', value: 'double' },
                ],
              },
              {
                displayName: 'Approve Button Label',
                name: 'approveLabel',
                type: 'string',
                default: DEFAULT_APPROVE_LABEL,
              },
              {
                displayName: 'Approve Button Style',
                name: 'buttonApprovalStyle',
                type: 'options',
                default: 'primary',
                options: buttonStyleOptions,
              },
              {
                displayName: 'Decline Button Label',
                name: 'disapproveLabel',
                type: 'string',
                default: DEFAULT_DECLINE_LABEL,
                displayOptions: { show: { approvalType: ['double'] } },
              },
              {
                displayName: 'Decline Button Style',
                name: 'buttonDisapprovalStyle',
                type: 'options',
                default: 'secondary',
                options: buttonStyleOptions,
                displayOptions: { show: { approvalType: ['double'] } },
              },
            ],
          },
        ],
      },
      forType('approval'),
    ),
    shownWhen(
      {
        displayName: 'Define Form',
        name: 'defineForm',
        type: 'options',
        default: 'fields',
        noDataExpression: true,
        options: [
          { name: 'Using Fields Below', value: 'fields' },
          { name: 'Using JSON', value: 'json' },
        ],
      },
      forType('customForm'),
    ),
    shownWhen(
      {
        displayName: 'Form Fields',
        name: 'jsonOutput',
        type: 'json',
        default:
          '[\n  {\n    "fieldLabel": "Name",\n    "fieldType": "text",\n    "requiredField": true\n  }\n]',
        typeOptions: { rows: 5 },
        description: 'A list of form elements, with the same names as in Form Elements',
      },
      { ...forType('customForm'), defineForm: ['json'] },
    ),
    shownWhen(formFieldsProperty, { ...forType('customForm'), defineForm: ['fields'] }),
    shownWhen(optionsCollection([limitWaitTimeOption]), forType('approval')),
    shownWhen(optionsCollection([...pageOptions, limitWaitTimeOption]), forType('freeText')),
    shownWhen(
      optionsCollection([...pageOptions, customCssOption, limitWaitTimeOption]),
      forType('customForm'),
    ),
  ];
}
