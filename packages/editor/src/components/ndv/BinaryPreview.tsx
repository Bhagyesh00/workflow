/**
 * Binary data of a run as file cards (name, mime type, size, View when previewable, Download)
 * and a preview dialog (P3-08), as n8n's binary data view. Video, JSON, markdown, HTML and other
 * text open in the same dialog through RichPreview (P3-14).
 *
 * Previews never point the page at /rest/binary-data: the bytes are fetched (or decoded when
 * inline), wrapped in a Blob typed with the allow-listed mime type (lib/binary-preview.ts) and
 * shown through an object URL in a native <img>, <audio> or the browser's PDF viewer. A PDF must
 * start with `%PDF-`. Object URLs are revoked when the preview or the card goes away. Rich kinds
 * get the typed Blob itself (RichPreview reads text or makes its own video URL).
 */
import type { BinaryData, Item } from '@workflow/workflow';
import { Download, Eye, FileBox } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fetchBinaryData } from '../../api/endpoints';
import {
  binarySize,
  downloadName,
  formatBytes,
  isPdfBytes,
  isRichKind,
  PREVIEW_MAX_BYTES,
  type PreviewKind,
  previewAccess,
} from '../../lib/binary-preview';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Spinner } from '../ui/misc';
import { RichPreview } from './RichPreview';

const MAX_CARDS = 12;

interface BinaryFile {
  key: string;
  property: string;
  binary: BinaryData;
}

type Loaded =
  | { state: 'loading' }
  /** `url` is set for image, audio and PDF; rich kinds use the blob */
  | { state: 'ready'; blob: Blob; url: string | null }
  | { state: 'error'; message: string };

/**
 * Load `binary` as a Blob typed `mimeType` while `enabled`, with an object URL for the kinds the
 * browser shows natively (image, audio, PDF). The URL is revoked when the inputs change or the
 * component unmounts.
 */
function useBinaryObjectUrl(
  binary: BinaryData,
  mimeType: string | null,
  kind: PreviewKind | null,
  enabled: boolean,
): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  useEffect(() => {
    if (!enabled || !mimeType || !kind) return;
    const controller = new AbortController();
    let url: string | null = null;
    let active = true;
    setLoaded({ state: 'loading' });
    (async () => {
      const blob = await fetchBinaryData(binary, { type: mimeType, signal: controller.signal });
      if (!active) return;
      if (blob.size > PREVIEW_MAX_BYTES) {
        setLoaded({ state: 'error', message: 'This file is too large to preview. Download it instead.' });
        return;
      }
      if (kind === 'pdf' && !(await isPdfBytes(blob))) {
        if (active)
          setLoaded({ state: 'error', message: 'This file is not a valid PDF, so it is not shown.' });
        return;
      }
      if (!active) return;
      if (isRichKind(kind)) {
        setLoaded({ state: 'ready', blob, url: null });
        return;
      }
      url = URL.createObjectURL(blob);
      setLoaded({ state: 'ready', blob, url });
    })().catch((error: unknown) => {
      if (!active) return;
      setLoaded({
        state: 'error',
        message: error instanceof Error && error.message ? error.message : "Couldn't load the file.",
      });
    });
    return () => {
      active = false;
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [binary, mimeType, kind, enabled]);
  return loaded;
}

/** Download the bytes through a short-lived object URL (works for stored and inline binaries). */
async function downloadBinary(binary: BinaryData, property: string): Promise<void> {
  try {
    const blob = await fetchBinaryData(binary, { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = downloadName(binary, property);
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    toast.error("Couldn't download the file", error instanceof Error ? error.message : undefined);
  }
}

function DownloadButton({
  binary,
  property,
  size = 'sm',
}: {
  binary: BinaryData;
  property: string;
  size?: 'sm' | 'md';
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size={size}
      variant={size === 'sm' ? 'ghost' : 'secondary'}
      icon={<Download size={size === 'sm' ? 12 : 14} />}
      loading={busy}
      onClick={() => {
        setBusy(true);
        void downloadBinary(binary, property).finally(() => setBusy(false));
      }}
    >
      Download
    </Button>
  );
}

function PreviewBody({
  binary,
  kind,
  name,
  loaded,
}: {
  binary: BinaryData;
  kind: PreviewKind;
  name: string;
  loaded: Loaded;
}) {
  if (loaded.state === 'loading') {
    return (
      <div className="grid h-48 place-items-center text-ink-3">
        <Spinner />
      </div>
    );
  }
  if (loaded.state === 'error') {
    return <p className="py-8 text-center text-sm text-ink-2">{loaded.message}</p>;
  }
  if (isRichKind(kind)) return <RichPreview binary={binary} blob={loaded.blob} />;
  if (!loaded.url) return null;
  if (kind === 'image') {
    return (
      <div className="flex justify-center">
        <img src={loaded.url} alt={name} className="max-h-[70vh] max-w-full object-contain" />
      </div>
    );
  }
  if (kind === 'audio') {
    return (
      // biome-ignore lint/a11y/useMediaCaption: user binary data has no caption track
      <audio src={loaded.url} controls preload="metadata" className="w-full" />
    );
  }
  return (
    <iframe
      src={loaded.url}
      title={name}
      sandbox=""
      referrerPolicy="no-referrer"
      className="h-[70vh] w-full rounded-lg border border-line bg-surface-2"
    />
  );
}

function BinaryPreviewDialog({
  file,
  kind,
  mimeType,
  onClose,
}: {
  file: BinaryFile;
  kind: PreviewKind;
  mimeType: string;
  onClose: () => void;
}) {
  const name = downloadName(file.binary, file.property);
  const loaded = useBinaryObjectUrl(file.binary, mimeType, kind, true);
  return (
    <Dialog
      open
      onClose={onClose}
      title={name}
      description={[mimeType, formatBytes(binarySize(file.binary))].filter(Boolean).join(' · ')}
      size={kind === 'image' || kind === 'audio' || kind === 'video' ? 'lg' : 'xl'}
      footer={<DownloadButton binary={file.binary} property={file.property} size="md" />}
    >
      <PreviewBody binary={file.binary} kind={kind} name={name} loaded={loaded} />
    </Dialog>
  );
}

function Thumbnail({ binary, mimeType, name }: { binary: BinaryData; mimeType: string; name: string }) {
  const loaded = useBinaryObjectUrl(binary, mimeType, 'image', true);
  if (loaded.state !== 'ready' || !loaded.url) {
    return <FileBox size={14} className="shrink-0 text-ink-3" />;
  }
  return <img src={loaded.url} alt={name} className="size-8 shrink-0 rounded object-cover" />;
}

function BinaryFileCard({ file }: { file: BinaryFile }) {
  const [open, setOpen] = useState(false);
  const { binary, property } = file;
  const name = downloadName(binary, property);
  const access = previewAccess(binary);
  const size = formatBytes(binarySize(binary));
  return (
    <fieldset
      aria-label={name}
      className="m-0 flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-line bg-surface-2 px-2 py-1"
    >
      {access.kind && access.thumbnail ? (
        <Thumbnail binary={binary} mimeType={access.mimeType} name={name} />
      ) : (
        <FileBox size={14} className="shrink-0 text-ink-3" />
      )}
      <div className="min-w-0 text-2xs leading-4">
        <div className="truncate font-semibold text-ink" title={name}>
          {name}
        </div>
        <div className="flex gap-1.5 text-ink-3">
          <span className="truncate">{binary.mimeType}</span>
          {size && <span>{size}</span>}
          {!access.kind && access.reason === 'size' && <span>Too large to preview</span>}
        </div>
      </div>
      {access.kind && (
        <Button size="sm" variant="ghost" icon={<Eye size={12} />} onClick={() => setOpen(true)}>
          View
        </Button>
      )}
      <DownloadButton binary={binary} property={property} />
      {open && access.kind && (
        <BinaryPreviewDialog
          file={file}
          kind={access.kind}
          mimeType={access.mimeType}
          onClose={() => setOpen(false)}
        />
      )}
    </fieldset>
  );
}

/** File cards for every binary property of `items` (input and output panes). */
export function BinaryFiles({ items }: { items: Item[] }) {
  const files: BinaryFile[] = items.flatMap((item, index) =>
    Object.entries(item.binary ?? {}).map(([property, binary]) => ({
      key: `${index}-${property}`,
      property,
      binary,
    })),
  );
  if (!files.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 border-b border-line px-2 py-1.5">
      {files.slice(0, MAX_CARDS).map((file) => (
        <BinaryFileCard key={file.key} file={file} />
      ))}
      {files.length > MAX_CARDS && (
        <span className="self-center text-2xs text-ink-3">{files.length - MAX_CARDS} more files</span>
      )}
    </div>
  );
}
