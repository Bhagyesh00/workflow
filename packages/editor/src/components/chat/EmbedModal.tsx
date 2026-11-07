/**
 * "Embed chat" (P5-59): the production chat URL of a public Chat Trigger and four ways to use it: a
 * script tag from this server, React, Vue, and the URL alone for any other client. Snippets hold the
 * production URL only: no test token, no key.
 */
import { Copy } from 'lucide-react';
import { useWebhookUrls } from '../../api/queries';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Callout, Spinner } from '../ui/misc';

export interface EmbedSnippet {
  id: 'script' | 'react' | 'vue' | 'other';
  title: string;
  hint: string;
  code: string;
}

/** The four snippets for a chat URL; `origin` is where the widget files are served from. */
export function embedSnippets(productionUrl: string, origin: string): EmbedSnippet[] {
  const url = JSON.stringify(productionUrl);
  const css = `${origin}/chat-widget/chat.css`;
  const js = `${origin}/chat-widget/chat.js`;
  return [
    {
      id: 'script',
      title: 'Script tag',
      hint: 'Paste it into any page. The widget files come from this server.',
      code: [
        `<link rel="stylesheet" href="${css}">`,
        '<div id="chat"></div>',
        `<script src="${js}"></script>`,
        '<script>',
        `  WorkflowChat.createChat({ webhookUrl: ${url}, target: '#chat', mode: 'fullscreen' });`,
        '</script>',
      ].join('\n'),
    },
    {
      id: 'react',
      title: 'React',
      hint: `Load ${js} and ${css} once in your index.html, then:`,
      code: [
        "import { useEffect, useRef } from 'react';",
        '',
        'export function Chat() {',
        '  const target = useRef(null);',
        '  useEffect(() => {',
        '    const chat = window.WorkflowChat.createChat({',
        `      webhookUrl: ${url},`,
        '      target: target.current,',
        "      mode: 'fullscreen',",
        '    });',
        '    return () => chat.unmount();',
        '  }, []);',
        '  return <div ref={target} style={{ height: 600 }} />;',
        '}',
      ].join('\n'),
    },
    {
      id: 'vue',
      title: 'Vue',
      hint: `Load ${js} and ${css} once in your index.html, then:`,
      code: [
        '<script setup>',
        "import { onMounted, onBeforeUnmount, ref } from 'vue';",
        '',
        'const target = ref(null);',
        'let chat;',
        'onMounted(() => {',
        '  chat = window.WorkflowChat.createChat({',
        `    webhookUrl: ${url},`,
        '    target: target.value,',
        "    mode: 'fullscreen',",
        '  });',
        '});',
        'onBeforeUnmount(() => chat?.unmount());',
        '</script>',
        '',
        '<template>',
        '  <div ref="target" style="height: 600px"></div>',
        '</template>',
      ].join('\n'),
    },
    {
      id: 'other',
      title: 'Other clients',
      hint: 'POST JSON { "action": "sendMessage", "sessionId": "...", "chatInput": "..." } to this URL.',
      code: productionUrl,
    },
  ];
}

async function copyText(text: string, label: string): Promise<void> {
  try {
    if (!navigator.clipboard) throw new Error('The clipboard is not available in this browser.');
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch (error) {
    toast.error('Could not copy', error instanceof Error ? error.message : undefined);
  }
}

export function EmbedModal({
  open,
  onClose,
  workflowId,
  nodeName,
}: {
  open: boolean;
  onClose: () => void;
  workflowId: string | undefined;
  nodeName: string;
}) {
  const urls = useWebhookUrls(workflowId, open);
  const productionUrl = urls.data?.find((hook) => hook.nodeName === nodeName)?.productionUrl;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Embed chat"
      description="Put this chat on a website. It needs the workflow to be active."
      size="lg"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {urls.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-ink-2">
          <Spinner /> Loading the chat URL
        </div>
      ) : !productionUrl ? (
        <Callout tone="warn" title="No chat URL yet">
          Save the workflow to get the URL of this Chat Trigger.
        </Callout>
      ) : (
        <div className="flex flex-col gap-4">
          <Callout tone="info" title="Allowed Origins">
            A page on another site can call the chat only when its origin is in the Allowed Origins option of
            the Chat Trigger.
          </Callout>
          {embedSnippets(productionUrl, origin).map((snippet) => (
            <section key={snippet.id} aria-label={snippet.title} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display text-sm font-semibold text-ink">{snippet.title}</h3>
                <Button
                  size="sm"
                  icon={<Copy size={13} />}
                  onClick={() => void copyText(snippet.code, snippet.title)}
                  aria-label={`Copy ${snippet.title} snippet`}
                >
                  Copy
                </Button>
              </div>
              <p className="text-xs text-ink-2">{snippet.hint}</p>
              <pre className="wf-scroll max-h-56 overflow-auto rounded-lg border border-line bg-surface-2 p-3 text-xs">
                <code>{snippet.code}</code>
              </pre>
            </section>
          ))}
        </div>
      )}
    </Dialog>
  );
}
