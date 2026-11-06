/** Form Elements and the Form Trigger's parameters (n8n's names and defaults), shared by the form nodes. */
import type { NodeProperty } from '@workflow/workflow';

export type FormFieldType =
  | 'checkbox'
  | 'date'
  | 'dropdown'
  | 'email'
  | 'file'
  | 'hiddenField'
  | 'html'
  | 'number'
  | 'password'
  | 'radio'
  | 'text'
  | 'textarea';

/** one entry of Form Elements, as the node parameter holds it */
export interface FormField {
  fieldType?: FormFieldType;
  fieldLabel?: string;
  fieldName?: string;
  placeholder?: string;
  defaultValue?: string | number;
  fieldValue?: string;
  fieldOptions?: { values?: Array<{ option?: string }> };
  limitSelection?: 'exact' | 'range' | 'unlimited';
  numberOfSelections?: number;
  minSelections?: number;
  maxSelections?: number;
  multipleFiles?: boolean;
  acceptFileTypes?: string;
  html?: string;
  elementName?: string;
  requiredField?: boolean;
}

const OPTION_TYPES: FormFieldType[] = ['checkbox', 'dropdown', 'radio'];
const DEFAULT_TYPES: FormFieldType[] = [
  'checkbox',
  'date',
  'dropdown',
  'email',
  'number',
  'radio',
  'text',
  'textarea',
];

export const FORM_DEFAULT_SUBMITTED_TEXT = 'Your response has been recorded';
export const FORM_DEFAULT_BUTTON_LABEL = 'Submit';

export const formFieldsProperty: NodeProperty = {
  displayName: 'Form Elements',
  name: 'formFields',
  type: 'fixedCollection',
  default: {},
  placeholder: 'Add Form Element',
  typeOptions: { multipleValues: true, sortable: true },
  options: [
    {
      displayName: 'Values',
      name: 'values',
      values: [
        {
          displayName: 'Element Type',
          name: 'fieldType',
          type: 'options',
          default: 'text',
          description: 'The type of field to add to the form',
          options: [
            { name: 'Checkboxes', value: 'checkbox' },
            { name: 'Custom HTML', value: 'html' },
            { name: 'Date', value: 'date' },
            { name: 'Dropdown', value: 'dropdown' },
            { name: 'Email', value: 'email' },
            { name: 'File', value: 'file' },
            { name: 'Hidden Field', value: 'hiddenField' },
            { name: 'Number', value: 'number' },
            { name: 'Password', value: 'password' },
            { name: 'Radio Buttons', value: 'radio' },
            { name: 'Text Input', value: 'text' },
            { name: 'Textarea', value: 'textarea' },
          ],
        },
        {
          displayName: 'Label',
          name: 'fieldLabel',
          type: 'string',
          default: '',
          placeholder: 'e.g. What is your name?',
          description: 'Label that appears above the field',
          displayOptions: { hide: { fieldType: ['hiddenField', 'html'] } },
        },
        {
          displayName: 'Field Name',
          name: 'fieldName',
          type: 'string',
          default: '',
          description: 'The key of this answer in the output. Empty uses the label.',
          displayOptions: { hide: { fieldType: ['html'] } },
        },
        {
          displayName: 'Placeholder',
          name: 'placeholder',
          type: 'string',
          default: '',
          description: 'Sample text shown inside the empty field',
          displayOptions: { hide: { fieldType: [...OPTION_TYPES, 'file', 'hiddenField', 'html', 'date'] } },
        },
        {
          displayName: 'Default Value',
          name: 'defaultValue',
          type: 'string',
          default: '',
          description: 'What the field holds when the form opens. Checkboxes take a comma-separated list.',
          displayOptions: { show: { fieldType: DEFAULT_TYPES } },
        },
        {
          displayName: 'Field Value',
          name: 'fieldValue',
          type: 'string',
          default: '',
          description: 'The value of the hidden field. A query parameter of the same name replaces it.',
          displayOptions: { show: { fieldType: ['hiddenField'] } },
        },
        {
          displayName: 'Field Options',
          name: 'fieldOptions',
          type: 'fixedCollection',
          default: { values: [{ option: '' }] },
          placeholder: 'Add Field Option',
          typeOptions: { multipleValues: true, sortable: true },
          displayOptions: { show: { fieldType: OPTION_TYPES } },
          options: [
            {
              displayName: 'Values',
              name: 'values',
              values: [{ displayName: 'Option', name: 'option', type: 'string', default: '' }],
            },
          ],
        },
        {
          displayName: 'Limit Selection',
          name: 'limitSelection',
          type: 'options',
          default: 'unlimited',
          displayOptions: { show: { fieldType: ['checkbox'] } },
          options: [
            { name: 'Exact Number', value: 'exact' },
            { name: 'Range', value: 'range' },
            { name: 'Unlimited', value: 'unlimited' },
          ],
        },
        {
          displayName: 'Number of Selections',
          name: 'numberOfSelections',
          type: 'number',
          default: 1,
          typeOptions: { minValue: 1 },
          displayOptions: { show: { fieldType: ['checkbox'], limitSelection: ['exact'] } },
        },
        {
          displayName: 'Minimum Selections',
          name: 'minSelections',
          type: 'number',
          default: 0,
          typeOptions: { minValue: 0 },
          displayOptions: { show: { fieldType: ['checkbox'], limitSelection: ['range'] } },
        },
        {
          displayName: 'Maximum Selections',
          name: 'maxSelections',
          type: 'number',
          default: 1,
          typeOptions: { minValue: 1 },
          displayOptions: { show: { fieldType: ['checkbox'], limitSelection: ['range'] } },
        },
        {
          displayName: 'Multiple Files',
          name: 'multipleFiles',
          type: 'boolean',
          default: true,
          description:
            'Whether the field takes more than one file. All files share the size limit of the server.',
          displayOptions: { show: { fieldType: ['file'] } },
        },
        {
          displayName: 'Accepted File Types',
          name: 'acceptFileTypes',
          type: 'string',
          default: '',
          placeholder: 'e.g. .jpg, .png',
          description: 'Comma-separated file extensions. Empty accepts any file.',
          displayOptions: { show: { fieldType: ['file'] } },
        },
        {
          displayName: 'HTML',
          name: 'html',
          type: 'string',
          default: '',
          typeOptions: { rows: 4 },
          description:
            'HTML shown on the form. Each {{ }} is resolved once. Scripts, styles and inputs are removed.',
          displayOptions: { show: { fieldType: ['html'] } },
        },
        {
          displayName: 'Element Name',
          name: 'elementName',
          type: 'string',
          default: '',
          description: 'Set a name to add this HTML to the output under that key',
          displayOptions: { show: { fieldType: ['html'] } },
        },
        {
          displayName: 'Required Field',
          name: 'requiredField',
          type: 'boolean',
          default: false,
          description: 'Whether the form asks for an answer before it submits',
          displayOptions: { hide: { fieldType: ['hiddenField', 'html'] } },
        },
      ],
    },
  ],
};

export const formTitleProperty: NodeProperty = {
  displayName: 'Form Title',
  name: 'formTitle',
  type: 'string',
  default: '',
  required: true,
  placeholder: 'e.g. Contact us',
  description: 'Shown at the top of the form and in the browser tab',
};

export const formDescriptionProperty: NodeProperty = {
  displayName: 'Form Description',
  name: 'formDescription',
  type: 'string',
  default: '',
  typeOptions: { rows: 2 },
  placeholder: "e.g. We'll get back to you soon",
  description: 'Shown under the title. HTML is allowed; scripts, styles and inputs are removed.',
};

export const formAuthenticationProperty: NodeProperty = {
  displayName: 'Authentication',
  name: 'authentication',
  type: 'options',
  default: 'none',
  noDataExpression: true,
  options: [
    { name: 'Basic Auth', value: 'basicAuth' },
    { name: 'User Auth', value: 'n8nUserAuth' },
    { name: 'None', value: 'none' },
  ],
};

export const formResponseModeProperty: NodeProperty = {
  displayName: 'Respond When',
  name: 'responseMode',
  type: 'options',
  default: 'onReceived',
  description: 'When the form answers the person who submitted it',
  options: [
    { name: 'Form Is Submitted', value: 'onReceived', description: 'As soon as the form is submitted' },
    {
      name: 'Workflow Finishes',
      value: 'lastNode',
      description: 'When the last node of the workflow is done',
    },
  ],
};

const appendAttribution: NodeProperty = {
  displayName: 'Append Attribution',
  name: 'appendAttribution',
  type: 'boolean',
  default: true,
  description: 'Whether to mention at the bottom of the form that it is automated',
};

const customCss: NodeProperty = {
  displayName: 'Custom Form Styling',
  name: 'customCss',
  type: 'string',
  default: '',
  typeOptions: { rows: 6 },
  description: 'CSS added to the form page',
};

const respondWithOptions: NodeProperty = {
  displayName: 'Form Response',
  name: 'respondWithOptions',
  type: 'fixedCollection',
  default: { values: { respondWith: 'text' } },
  placeholder: 'Add Option',
  options: [
    {
      displayName: 'Values',
      name: 'values',
      values: [
        {
          displayName: 'Respond With',
          name: 'respondWith',
          type: 'options',
          default: 'text',
          options: [
            {
              name: 'Form Submitted Text',
              value: 'text',
              description: 'Show a text after the form is submitted',
            },
            { name: 'Redirect URL', value: 'redirect', description: 'Go to an http or https URL' },
          ],
        },
        {
          displayName: 'Text to Show',
          name: 'formSubmittedText',
          type: 'string',
          default: FORM_DEFAULT_SUBMITTED_TEXT,
          displayOptions: { show: { respondWith: ['text'] } },
        },
        {
          displayName: 'URL to Redirect to',
          name: 'redirectUrl',
          type: 'string',
          default: '',
          placeholder: 'e.g. https://www.example.com',
          displayOptions: { show: { respondWith: ['redirect'] } },
        },
      ],
    },
  ],
};

/** the Form Trigger's Options */
export const formTriggerOptionsProperty: NodeProperty = {
  displayName: 'Options',
  name: 'options',
  type: 'collection',
  default: {},
  placeholder: 'Add option',
  options: [
    appendAttribution,
    {
      displayName: 'Button Label',
      name: 'buttonLabel',
      type: 'string',
      default: FORM_DEFAULT_BUTTON_LABEL,
    },
    customCss,
    {
      displayName: 'Form Path',
      name: 'path',
      type: 'string',
      default: '',
      placeholder: 'e.g. contact-us',
      description: 'The last part of the form URL. Empty uses the id of this node.',
    },
    respondWithOptions,
    {
      displayName: 'IP(s) Allowlist',
      name: 'ipWhitelist',
      type: 'string',
      default: '',
      placeholder: 'e.g. 127.0.0.1, 192.168.1.0/24',
      description: 'Comma-separated IPs or CIDR ranges allowed to open the form. Empty allows all.',
    },
    {
      displayName: 'Ignore Bots',
      name: 'ignoreBots',
      type: 'boolean',
      default: false,
      description: 'Whether to ignore link previewers and web crawlers',
    },
    {
      displayName: 'Include User in Output',
      name: 'includeUserInOutput',
      type: 'boolean',
      default: true,
      description: 'Whether to add the signed-in user to the output',
      displayOptions: { show: { '/authentication': ['n8nUserAuth'] } },
    },
    {
      displayName: 'Show Headers',
      name: 'showHeaders',
      type: 'boolean',
      default: false,
      description: 'Whether to add the request headers to the output, without the sensitive ones',
    },
    {
      displayName: 'Use Workflow Timezone',
      name: 'useWorkflowTimezone',
      type: 'boolean',
      default: true,
      description: 'Whether submittedAt uses the timezone of the workflow, otherwise UTC',
    },
  ],
};
