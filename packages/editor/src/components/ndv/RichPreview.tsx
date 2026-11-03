/**
 * Previews of video, JSON, text, markdown and HTML binaries (P3-14): kind from the base mime type,
 * never fileType; HTML in `<iframe sandbox="" srcdoc referrerpolicy="no-referrer">` with the CSP
 * meta (lib/html-preview.ts). Used by BinaryPreview, which has already checked the 25 MB cap and
 * typed the blob with the allow-listed mime type.
 *
 * Video plays from an object URL in a native `<video controls>` (no autoplay), revoked on unmount.
 * JSON is the run data tree (RunDataView's JsonNode, three levels open); invalid JSON is shown as
 * text. Markdown renders through lib/markdown.tsx as React elements, so raw HTML and images stay
 * text. Other text/* is a `<pre>` block. Nothing here sets HTML on the editor page.
 */
import type { BinaryData } from '@workflow/workflow';
import { useEffect, useMemo, useState } from 'react';
import { previewKind, readBlobText } from '../../lib/binary-preview';
import { buildHtmlPreview } from '../../lib/html-preview';
import { Markdown } from '../../lib/markdown';
import { Spinner } from '../ui/misc';
import { JsonNode } from './RunDataView';

export interface RichPreviewProps {
  binary: BinaryData;
  /** the bytes, typed from the allow-listed mime type */
  blob: Blob;
}

type Text = { state: 'loading' } | { state: 'ready'; text: string } | { state: 'error'; message: string };

function useBlobText(blob: Blob, enabled: boolean): Text {
  const [text, setText] = useState<Text>({ state: 'loading' });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setText({ state: 'loading' });
    readBlobText(blob).then(
      (value) => {
        if (active) setText({ state: 'ready', text: value });
      },
      () => {
        if (active) setText({ state: 'error', message: "Couldn't read the file as text." });
      },
    );
    return () => {
      active = false;
    };
  }, [blob, enabled]);
  return text;
}

function VideoPreview({ blob }: { blob: Blob }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const created = URL.createObjectURL(blob);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [blob]);
  if (!url) return null;
  return (
    // biome-ignore lint/a11y/useMediaCaption: user binary data has no caption track
    <video
      src={url}
      controls
      preload="metadata"
      playsInline
      className="max-h-[70vh] w-full rounded-lg bg-black"
    />
  );
}

const textBlock =
  'wf-scroll max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs leading-5 text-ink';

type ParsedJson = { ok: true; value: unknown } | { ok: false };

function JsonPreview({ text }: { text: string }) {
  const parsed = useMemo<ParsedJson>(() => {
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false };
    }
  }, [text]);
  if (!parsed.ok) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-ink-3">This file is not valid JSON, so it is shown as text.</p>
        <pre className={textBlock}>{text}</pre>
      </div>
    );
  }
  return (
    <div className="wf-scroll max-h-[70vh] overflow-auto rounded-lg border border-line bg-surface-2 p-2 font-mono text-xs leading-5">
      <JsonNode value={parsed.value} path={[]} depth={0} />
    </div>
  );
}

const markdownBody = [
  'wf-scroll max-h-[70vh] overflow-auto rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm leading-6 text-ink',
  '[&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold',
  '[&_h3]:mb-1 [&_h3]:font-semibold',
].join(' ');

function HtmlPreview({ text, title }: { text: string; title: string }) {
  const srcDoc = useMemo(() => buildHtmlPreview(text), [text]);
  return (
    <iframe
      title={title}
      sandbox=""
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
      className="h-[70vh] w-full rounded-lg border border-line bg-white"
    />
  );
}

export function RichPreview({ binary, blob }: RichPreviewProps) {
  const kind = previewKind(binary);
  const textual = kind === 'json' || kind === 'markdown' || kind === 'html' || kind === 'text';
  const text = useBlobText(blob, textual);
  if (kind === 'video') return <VideoPreview blob={blob} />;
  if (!textual) return null;
  if (text.state === 'loading') {
    return (
      <div className="grid h-48 place-items-center text-ink-3">
        <Spinner />
      </div>
    );
  }
  if (text.state === 'error') {
    return <p className="py-8 text-center text-sm text-ink-2">{text.message}</p>;
  }
  if (kind === 'json') return <JsonPreview text={text.text} />;
  if (kind === 'markdown') {
    return (
      <div className={markdownBody}>
        <Markdown source={text.text} />
      </div>
    );
  }
  if (kind === 'html') return <HtmlPreview text={text.text} title={binary.fileName || 'HTML preview'} />;
  return <pre className={textBlock}>{text.text}</pre>;
}
