/**
 * Chat Trigger: a POST webhook receiving `{ sessionId, chatInput, metadata? }` and starting the
 * workflow with one item `{ sessionId, action: 'sendMessage', chatInput }`. A GET on the same
 * path returns the public chat configuration (initial messages, labels) for chat widgets.
 *
 * Public ingress rules (security S7): strict body validation with size limits, Basic auth or workspace
 * sign-in (chat-access.ts), an Origin allow-list, and no access to anything but the request itself.
 * `loadPreviousSession` answers the history of the memory node wired to the trigger (P5-57).
 */
import { loadConnectPanel } from '@workflow/nodes-base/utils/connect-panel';
import {
  type DataObject,
  HIGHLIGHTED_SESSION_KEY,
  highlightedInputKey,
  type Item,
  isPlainObject,
  type NodeType,
  type WebhookResponseData,
} from '@workflow/workflow';
import { checkChatAccess, headerValue, loadChatHistory } from './chat-access';
import { injectChatConnectBar } from './chat-page';
import {
  chatOriginAllowed,
  DEFAULT_INITIAL_MESSAGES,
  handleChatSetup,
  MAX_CHAT_INPUT,
  MAX_SESSION_ID,
  readChatFiles,
  chatResponse as respond,
} from './chat-setup';

const MAX_METADATA_BYTES = 16_384;

/** the longest value a run's custom data keeps */
const MAX_HIGHLIGHTED_VALUE = 255;

const onUserAuth = { show: { public: [true], authentication: ['n8nUserAuth'] } };

export const ChatTriggerNode: NodeType = {
  description: {
    name: 'ai.chatTrigger',
    displayName: 'Chat Trigger',
    description: 'Starts the workflow when a chat message is received',
    icon: 'lucide:message-circle',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'When chat message received' },
    inputs:
      "={{ $parameter.options?.loadPreviousSession === 'memory' ? [{ type: 'ai_memory', displayName: 'Memory', maxConnections: 1 }] : [] }}",
    outputs: ['main'],
    categories: ['AI', 'Triggers'],
    alias: ['chat', 'chatbot', 'message', 'conversation'],
    eventTriggerDescription: 'Waiting for you to send a chat message',
    activationMessage: 'You can now send messages to the chat URL.',
    credentials: [
      {
        name: 'httpBasicAuth',
        required: true,
        displayOptions: { show: { public: [true], authentication: ['basicAuth'] } },
      },
    ],
    webhooks: [
      {
        name: 'default',
        httpMethod: 'POST',
        path: 'chat',
        responseMode: "={{ $parameter.options?.responseMode ?? 'lastNode' }}",
        responseData: 'firstEntryJson',
      },
      { name: 'setup', httpMethod: 'GET', path: 'chat', ndvHideUrl: true },
    ],
    properties: [
      {
        displayName: 'Make Chat Publicly Available',
        name: 'public',
        type: 'boolean',
        default: false,
        description:
          'Whether the chat URL works outside the editor. When off, only test messages from the editor are accepted.',
      },
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        default: 'hostedChat',
        noDataExpression: true,
        displayOptions: { show: { public: [true] } },
        options: [
          {
            name: 'Hosted Chat',
            value: 'hostedChat',
            description: 'Chat on a page this app serves at the chat URL',
          },
          {
            name: 'Embedded Chat',
            value: 'webhook',
            description: 'Chat through the widget or your own client on another site',
          },
        ],
      },
      {
        displayName: 'Authentication',
        name: 'authentication',
        type: 'options',
        default: 'none',
        displayOptions: { show: { public: [true] } },
        options: [
          { name: 'None', value: 'none', description: 'Anyone with the URL can chat' },
          { name: 'Basic Auth', value: 'basicAuth' },
          {
            name: 'Workspace Sign-in',
            value: 'n8nUserAuth',
            description: 'Only signed-in members of this workspace can chat',
          },
        ],
      },
      {
        displayName: 'Trusted Source',
        name: 'trustedSource',
        type: 'options',
        default: 'workspaceSignIn',
        noDataExpression: true,
        description: 'Who says the person opening the chat is signed in',
        options: [{ name: 'Workspace sign-in', value: 'workspaceSignIn' }],
        displayOptions: onUserAuth,
      },
      {
        displayName: 'Require Workflow Execute Permission',
        name: 'requireExecuteAccess',
        type: 'boolean',
        default: false,
        description: 'Whether only members who may run this workflow, editors and above, can chat',
        displayOptions: onUserAuth,
      },
      {
        displayName: 'Include User in Output',
        name: 'includeUserInOutput',
        type: 'boolean',
        default: true,
        description: 'Whether the signed-in user (id, email, first and last name) is added to the output',
        displayOptions: onUserAuth,
      },
      {
        displayName: 'Initial Message(s)',
        name: 'initialMessages',
        type: 'string',
        default: DEFAULT_INITIAL_MESSAGES,
        typeOptions: { rows: 3 },
        description: 'Shown when a chat opens; one message per line',
        displayOptions: { show: { public: [true] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Allowed Origins (CORS)',
            name: 'allowedOrigins',
            type: 'string',
            default: '*',
            description: 'Comma-separated origins allowed to call the chat from a browser, or * for any',
          },
          {
            displayName: 'Response Mode',
            name: 'responseMode',
            type: 'options',
            default: 'lastNode',
            options: [
              {
                name: 'When Last Node Finishes',
                value: 'lastNode',
                description: 'Answer with the output of the last node',
              },
              {
                name: 'Streaming',
                value: 'streaming',
                description: 'Stream the answer while it is generated (agents with streaming on)',
              },
              {
                name: 'Using Respond to Webhook Node',
                value: 'responseNode',
                description: 'Answer with what a Respond to Webhook node sends',
              },
              {
                name: 'Using Response Nodes',
                value: 'responseNodes',
                description:
                  'Answer with the messages of Respond to Chat nodes, which can also wait for a reply',
              },
            ],
          },
          { displayName: 'Allow File Uploads', name: 'allowFileUploads', type: 'boolean', default: false },
          {
            displayName: 'Allowed File MIME Types',
            name: 'allowedFilesMimeTypes',
            type: 'string',
            default: '*',
            placeholder: 'image/*, text/plain',
            description: 'Comma-separated MIME types; * allows any',
          },
          { displayName: 'Title', name: 'title', type: 'string', default: 'Hi there!' },
          {
            displayName: 'Subtitle',
            name: 'subtitle',
            type: 'string',
            default: "Start a chat. We're here to help you 24/7.",
          },
          {
            displayName: 'Input Placeholder',
            name: 'inputPlaceholder',
            type: 'string',
            default: 'Type your question…',
          },
          {
            displayName: 'Show Welcome Screen',
            name: 'showWelcomeScreen',
            type: 'boolean',
            default: false,
            description: 'Whether the hosted chat opens on a welcome screen with a start button',
          },
          {
            displayName: 'Start Button Text',
            name: 'getStarted',
            type: 'string',
            default: 'New Conversation',
            description: 'The label of the button on the welcome screen',
          },
          {
            displayName: 'Custom Chat Styling',
            name: 'customCss',
            type: 'string',
            default: '',
            typeOptions: { rows: 5 },
            description: 'CSS for the hosted chat page',
          },
          {
            displayName: 'Load Previous Session',
            name: 'loadPreviousSession',
            type: 'options',
            default: 'notSupported',
            options: [
              { name: 'Off', value: 'notSupported', description: 'A new conversation starts empty' },
              {
                name: 'From Memory',
                value: 'memory',
                description: 'Show the history of the memory node connected to this trigger',
              },
              {
                name: 'Manually',
                value: 'manually',
                description: 'Run the workflow with the load request; a Respond to Webhook node answers it',
              },
            ],
          },
          {
            displayName: 'Auto-save Highlighted Data',
            name: 'autoSaveHighlightedData',
            type: 'boolean',
            default: true,
            description:
              'Whether the message and the session ID are saved on the execution as data you can filter by',
          },
        ],
      },
    ],
  },

  async webhook(ctx) {
    const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
    const origin = chatOriginAllowed(ctx, String(options.allowedOrigins ?? '*'), headerValue(ctx, 'origin'));
    const corsOrigin = origin || undefined;

    const isSetup = ctx.getWebhookName() === 'setup';
    // the access check answers a refused Origin only after the off switch and the test-only rule
    const access = await checkChatAccess(ctx, corsOrigin, !isSetup, origin === false);
    if (access.refusal) return access.refusal;

    if (isSetup) {
      const page = await handleChatSetup(ctx, { corsOrigin, authToken: access.authToken });
      const reply = page.webhookResponse;
      // the sign-in cookie rides on the page reply (the route lets only the chat cookie through)
      if (reply && access.headers['set-cookie']) {
        reply.headers = { ...reply.headers, 'set-cookie': access.headers['set-cookie'] };
      }
      // P6-87: a signed-in visitor sees which private accounts a message needs and which they have connected
      if (reply && access.user && typeof reply.body === 'string') {
        const panel = await loadConnectPanel(
          ctx,
          access.user.id,
          ctx.getRequestObject().url?.split('?')[0] ?? '',
        );
        if (panel) reply.body = injectChatConnectBar(reply.body, panel);
      }
      return page;
    }

    const body = ctx.getRequestObject().body;
    if (!isPlainObject(body))
      return respond(400, { message: 'The request body must be a JSON object' }, corsOrigin);
    const action = body.action ?? 'sendMessage';
    if (action !== 'sendMessage' && action !== 'loadPreviousSession')
      return respond(400, { message: `Unknown action "${String(action)}"` }, corsOrigin);
    const { sessionId, chatInput, metadata } = body;
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > MAX_SESSION_ID) {
      return respond(
        400,
        { message: `"sessionId" must be a non-empty string of at most ${MAX_SESSION_ID} characters` },
        corsOrigin,
      );
    }
    // the caller never names the user: it is added only from a workspace sign-in with Include User on
    const user =
      access.user && ctx.getNodeParameter('includeUserInOutput', 0, true) !== false
        ? { user: { ...access.user } as DataObject }
        : {};
    // the person the sign-in identified: a run starts as them, whether or not Include User is on (P6-87)
    const identity = access.user ? { triggerUserId: access.user.id } : {};

    if (action === 'loadPreviousSession') {
      const mode = String(options.loadPreviousSession ?? 'notSupported');
      if (mode === 'manually') {
        return {
          workflowData: [[{ json: { sessionId, action: 'loadPreviousSession', ...user } }]],
          ...identity,
        };
      }
      if (mode !== 'memory') return respond(200, { data: [] }, corsOrigin);
      // the memory reads this same body as its item: give it what a run's item holds, never the caller's
      // `user`, and the signed-in user when Include User is on (a `$json.user.email` key then works)
      delete body.user;
      if (user.user) body.user = user.user;
      return respond(200, { data: await loadChatHistory(ctx, sessionId) }, corsOrigin);
    }

    if (typeof chatInput !== 'string' || !chatInput.trim()) {
      return respond(400, { message: '"chatInput" must be a non-empty string' }, corsOrigin);
    }
    if (chatInput.length > MAX_CHAT_INPUT) {
      return respond(413, { message: `"chatInput" is longer than ${MAX_CHAT_INPUT} characters` }, corsOrigin);
    }
    if (
      metadata !== undefined &&
      (!isPlainObject(metadata) || JSON.stringify(metadata).length > MAX_METADATA_BYTES)
    ) {
      return respond(
        400,
        { message: `"metadata" must be an object of at most ${MAX_METADATA_BYTES} bytes` },
        corsOrigin,
      );
    }

    const item: Item = {
      json: {
        sessionId,
        action: 'sendMessage',
        chatInput,
        ...(metadata !== undefined ? { metadata: metadata as DataObject } : {}),
        ...user,
      },
    };
    const uploads = await readChatFiles(ctx, options);
    if ('status' in uploads) return respond(uploads.status, { message: uploads.message }, corsOrigin);
    const keys = Object.keys(uploads.binary);
    if (keys.length) {
      item.binary = uploads.binary;
      const sent = ctx.getRequestObject().files ?? [];
      item.json.files = keys.map((binaryKey, index) => {
        const file = uploads.binary[binaryKey];
        return {
          fileName: file.fileName ?? sent[index]?.fileName ?? '',
          fileSize: file.fileSize ?? sent[index]?.data.length ?? 0,
          fileType: file.fileType ?? (file.mimeType.split('/')[0] || 'application'),
          mimeType: file.mimeType,
          fileExtension: file.fileExtension ?? '',
          binaryKey,
        };
      });
    }
    const result: WebhookResponseData = { workflowData: [[item]], ...identity };
    // on unless turned off, as n8n; chatInput and sessionId are checked strings here
    if (options.autoSaveHighlightedData !== false) {
      result.customData = {
        [highlightedInputKey(ctx.getNode().name)]: chatInput.slice(0, MAX_HIGHLIGHTED_VALUE),
        [HIGHLIGHTED_SESSION_KEY]: sessionId.slice(0, MAX_HIGHLIGHTED_VALUE),
      };
    }
    return result;
  },
};
