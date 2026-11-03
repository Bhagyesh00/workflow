/**
 * P3-08 binary previews: file cards, the preview dialog (image, audio, PDF from typed Blobs),
 * the allow-list (SVG is Download only; HTML goes to the sandboxed rich preview of P3-14, see
 * rich-preview.test.tsx; fileType never picks the renderer), the size caps, the %PDF- check,
 * object URL revoking, and the input pane.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BinaryData, Item, RunData, WorkflowNode } from '@workflow/workflow';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputPane } from '../src/components/ndv/DataPanes';
import { RunDataView } from '../src/components/ndv/RunDataView';
import {
  binarySize,
  formatBytes,
  isPdfBytes,
  PREVIEW_MAX_BYTES,
  previewAccess,
  previewKind,
} from '../src/lib/binary-preview';
import type { WorkflowGraph } from '../src/lib/workflow-ops';
import { server } from './setup';
import { withProviders } from './utils';

const b64 = (text: string) => btoa(text);

function bin(partial: Partial<BinaryData> & { mimeType: string }): BinaryData {
  return { data: b64('hello'), fileName: 'file.bin', ...partial };
}

function show(binary: BinaryData, property = 'data') {
  const items: Item[] = [{ json: { ok: true }, binary: { [property]: binary } }];
  return withProviders(<RunDataView items={items} mode="table" />);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('binary preview helpers', () => {
  it('picks the renderer from the allow-listed base mime type only', () => {
    expect(previewKind({ mimeType: 'image/png' })).toBe('image');
    expect(previewKind({ mimeType: 'IMAGE/JPEG; charset=binary' })).toBe('image');
    for (const mime of ['image/gif', 'image/webp', 'image/bmp', 'image/avif']) {
      expect(previewKind({ mimeType: mime })).toBe('image');
    }
    for (const mime of ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4', 'audio/aac']) {
      expect(previewKind({ mimeType: mime })).toBe('audio');
    }
    expect(previewKind({ mimeType: 'application/pdf' })).toBe('pdf');
    expect(previewKind({ mimeType: 'image/svg+xml' })).toBeNull();
    // P3-14: HTML is the sandboxed srcdoc preview (rich-preview.test.tsx), never an image
    expect(previewKind({ mimeType: 'text/html' })).toBe('html');
    expect(previewKind({ mimeType: 'image/tiff' })).toBeNull();
    expect(previewKind({ mimeType: '' })).toBeNull();
    // fileType is ignored
    expect(previewAccess(bin({ mimeType: 'text/html', fileType: 'image' })).kind).toBe('html');
  });

  it('measures size from fileSize or the base64 payload and caps previews at 25 MB', () => {
    expect(binarySize({ data: b64('hello'), fileSize: undefined })).toBe(5);
    expect(binarySize({ data: '', fileSize: 1234 })).toBe(1234);
    expect(binarySize({ data: '', fileSize: undefined })).toBeNull();
    expect(previewAccess(bin({ mimeType: 'image/png', fileSize: PREVIEW_MAX_BYTES + 1 }))).toEqual({
      kind: null,
      reason: 'size',
    });
    expect(previewAccess(bin({ mimeType: 'image/png', fileSize: 2000 }))).toMatchObject({
      kind: 'image',
      thumbnail: true,
    });
    expect(previewAccess(bin({ mimeType: 'image/png', fileSize: 2 * 1024 * 1024 }))).toMatchObject({
      kind: 'image',
      thumbnail: false,
    });
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 kB');
    expect(formatBytes(30 * 1024 * 1024)).toBe('30 MB');
  });

  it('checks the PDF header', async () => {
    expect(await isPdfBytes(new Blob(['%PDF-1.7\n...'], { type: 'application/pdf' }))).toBe(true);
    expect(await isPdfBytes(new Blob(['<html><script>'], { type: 'application/pdf' }))).toBe(false);
    expect(await isPdfBytes(new Blob(['%PD']))).toBe(false);
  });
});

describe('binary file cards and preview dialog', () => {
  it('shows a card with name, mime, size, a thumbnail and View for a small image', async () => {
    show(bin({ mimeType: 'image/png', fileName: 'logo.png', fileSize: 5 }));
    const card = screen.getByRole('group', { name: 'logo.png' });
    expect(within(card).getByText('image/png')).toBeTruthy();
    expect(within(card).getByText('5 B')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'View' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Download' })).toBeTruthy();
    const thumb = await within(card).findByRole('img', { name: 'logo.png' });
    expect(thumb.getAttribute('src')).toMatch(/^blob:/);
  });

  it('opens an image in the dialog from a blob URL typed with the allow-listed mime', async () => {
    const created: Blob[] = [];
    const original = URL.createObjectURL;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      created.push(blob as Blob);
      return original(blob as Blob);
    });
    show(bin({ mimeType: 'Image/PNG', fileName: 'big.png', fileSize: 2 * 1024 * 1024 }));
    const card = screen.getByRole('group', { name: 'big.png' });
    // over 1 MB: no thumbnail
    expect(within(card).queryByRole('img')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'View' }));
    const dialog = await screen.findByRole('dialog', { name: 'big.png' });
    const img = await within(dialog).findByRole('img', { name: 'big.png' });
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    expect(created.at(-1)?.type).toBe('image/png');
  });

  it('plays audio with controls and without autoplay', async () => {
    show(bin({ mimeType: 'audio/wav', fileName: 'beep.wav' }));
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    const dialog = await screen.findByRole('dialog', { name: 'beep.wav' });
    await waitFor(() => expect(dialog.querySelector('audio')).not.toBeNull());
    const audio = dialog.querySelector('audio')!;
    expect(audio.hasAttribute('controls')).toBe(true);
    expect(audio.hasAttribute('autoplay')).toBe(false);
    expect(audio.autoplay).toBe(false);
    expect(audio.getAttribute('src')).toMatch(/^blob:/);
  });

  it('shows a PDF in a sandboxed iframe from a blob URL', async () => {
    show(bin({ mimeType: 'application/pdf', fileName: 'doc.pdf', data: b64('%PDF-1.4\nbody') }));
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    const dialog = await screen.findByRole('dialog', { name: 'doc.pdf' });
    const frame = await within(dialog).findByTitle('doc.pdf');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toMatch(/^blob:/);
    expect(frame.hasAttribute('sandbox')).toBe(true);
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('refuses a "PDF" whose bytes do not start with %PDF-', async () => {
    show(bin({ mimeType: 'application/pdf', fileName: 'fake.pdf', data: b64('<html><script>x</script>') }));
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    const dialog = await screen.findByRole('dialog', { name: 'fake.pdf' });
    expect(await within(dialog).findByText(/not a valid PDF/)).toBeTruthy();
    expect(dialog.querySelector('iframe')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Download' })).toBeTruthy();
  });

  it('offers SVG as Download only and HTML as a View without a thumbnail', () => {
    const items: Item[] = [
      {
        json: {},
        binary: {
          logo: bin({ mimeType: 'image/svg+xml', fileName: 'logo.svg' }),
          page: bin({ mimeType: 'text/html', fileName: 'page.html' }),
        },
      },
    ];
    withProviders(<RunDataView items={items} mode="json" />);
    const svg = screen.getByRole('group', { name: 'logo.svg' });
    expect(within(svg).queryByRole('button', { name: 'View' })).toBeNull();
    expect(within(svg).queryByRole('img')).toBeNull();
    expect(within(svg).getByRole('button', { name: 'Download' })).toBeTruthy();
    const html = screen.getByRole('group', { name: 'page.html' });
    expect(within(html).getByRole('button', { name: 'View' })).toBeTruthy();
    expect(within(html).queryByRole('img')).toBeNull();
    expect(within(html).getByRole('button', { name: 'Download' })).toBeTruthy();
  });

  it('never previews from fileType: fileType image with mime text/html gets no image', () => {
    show(bin({ mimeType: 'text/html', fileType: 'image', fileName: 'trick.png', fileSize: 10 }));
    const card = screen.getByRole('group', { name: 'trick.png' });
    expect(within(card).queryByRole('img')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('keeps files over 25 MB to Download only', () => {
    show(
      bin({
        mimeType: 'application/pdf',
        fileName: 'huge.pdf',
        data: '',
        id: 'fs:t/e/1',
        fileSize: 30 * 1024 * 1024,
      }),
    );
    const card = screen.getByRole('group', { name: 'huge.pdf' });
    expect(within(card).queryByRole('button', { name: 'View' })).toBeNull();
    expect(within(card).getByText(/too large to preview/i)).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Download' })).toBeTruthy();
  });

  it('revokes the object URL when the dialog closes', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    show(bin({ mimeType: 'image/gif', fileName: 'anim.gif', fileSize: 2 * 1024 * 1024 }));
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    const dialog = await screen.findByRole('dialog', { name: 'anim.gif' });
    const src = (await within(dialog).findByRole('img', { name: 'anim.gif' })).getAttribute('src');
    expect(revoke).not.toHaveBeenCalledWith(src);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(revoke).toHaveBeenCalledWith(src);
  });

  it('loads a stored binary from /rest/binary-data and types the blob from the allow-list', async () => {
    let query: URLSearchParams | null = null;
    server.use(
      http.get('/rest/binary-data', ({ request }) => {
        query = new URL(request.url).searchParams;
        return new HttpResponse('%PDF-1.7 stored', { headers: { 'content-type': 'text/html' } });
      }),
    );
    show(
      bin({ mimeType: 'application/pdf', fileName: 'stored.pdf', data: '', id: 'fs:t/e/2', fileSize: 15 }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    const dialog = await screen.findByRole('dialog', { name: 'stored.pdf' });
    const frame = await within(dialog).findByTitle('stored.pdf');
    expect(frame.getAttribute('src')).toMatch(/^blob:/);
    expect(query!.get('id')).toBe('fs:t/e/2');
    expect(query!.get('action')).toBe('view');
  });

  it('downloads through a blob URL with the file name', async () => {
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this);
    });
    show(bin({ mimeType: 'image/svg+xml', fileName: 'logo.svg' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(clicks[0].download).toBe('logo.svg');
    expect(clicks[0].href).toMatch(/^blob:/);
  });

  it('shows the cards in the input pane too', () => {
    const source: WorkflowNode = {
      id: 'a',
      name: 'Source',
      type: 'core.manualTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    };
    const subject: WorkflowNode = { ...source, id: 'b', name: 'Subject', type: 'core.noOp' };
    const runData: RunData = {
      Source: [
        {
          startTime: 0,
          executionTime: 1,
          executionStatus: 'success',
          data: {
            main: [
              [{ json: { a: 1 }, binary: { data: bin({ mimeType: 'image/png', fileName: 'in.png' }) } }],
            ],
          },
          source: [],
        },
      ],
    };
    render(
      <InputPane
        graph={
          {
            nodes: [source, subject],
            connections: { Source: { main: [[{ node: 'Subject', type: 'main', index: 0 }]] } },
            pinData: {},
            stickyNotes: [],
            nodeGroups: [],
          } satisfies WorkflowGraph
        }
        node={subject}
        runData={runData}
        readOnly={false}
      />,
    );
    const card = screen.getByRole('group', { name: 'in.png' });
    expect(within(card).getByRole('button', { name: 'View' })).toBeTruthy();
  });
});
