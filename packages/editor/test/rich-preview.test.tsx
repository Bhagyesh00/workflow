/**
 * P3-14 rich previews: video, JSON (the run data tree, depth 3 open), markdown (React elements),
 * HTML (sandboxed srcdoc iframe with the CSP meta) and other text. The kind comes from the base
 * mime type, never from fileType; the 25 MB cap keeps big files to Download only.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BinaryData, Item } from '@workflow/workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RichPreview } from '../src/components/ndv/RichPreview';
import { RunDataView } from '../src/components/ndv/RunDataView';
import { PREVIEW_MAX_BYTES, previewAccess, previewKind } from '../src/lib/binary-preview';
import { Markdown } from '../src/lib/markdown';
import { withProviders } from './utils';

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`;

const b64 = (text: string) => btoa(unescape(encodeURIComponent(text)));

function bin(partial: Partial<BinaryData> & { mimeType: string }): BinaryData {
  return { data: b64('hello'), fileName: 'file.bin', ...partial };
}

function show(binary: BinaryData, property = 'data') {
  const items: Item[] = [{ json: {}, binary: { [property]: binary } }];
  return withProviders(<RunDataView items={items} mode="table" />);
}

async function open(binary: BinaryData) {
  show(binary);
  const name = binary.fileName!;
  fireEvent.click(within(screen.getByRole('group', { name })).getByRole('button', { name: 'View' }));
  return screen.findByRole('dialog', { name });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rich preview kinds', () => {
  it('maps video, JSON, markdown, HTML and other text from the base mime type', () => {
    for (const mime of ['video/mp4', 'video/webm', 'VIDEO/OGG; codecs=theora']) {
      expect(previewKind({ mimeType: mime })).toBe('video');
    }
    expect(previewKind({ mimeType: 'application/json' })).toBe('json');
    expect(previewKind({ mimeType: 'text/json; charset=utf-8' })).toBe('json');
    expect(previewKind({ mimeType: 'text/markdown' })).toBe('markdown');
    expect(previewKind({ mimeType: 'text/html' })).toBe('html');
    expect(previewKind({ mimeType: 'text/plain' })).toBe('text');
    expect(previewKind({ mimeType: 'text/csv' })).toBe('text');
    // still Download only
    expect(previewKind({ mimeType: 'image/svg+xml' })).toBeNull();
    expect(previewKind({ mimeType: 'application/xhtml+xml' })).toBeNull();
    expect(previewKind({ mimeType: 'video/quicktime' })).toBeNull();
    expect(previewKind({ mimeType: 'text/' })).toBeNull();
    expect(previewAccess(bin({ mimeType: 'text/html', fileSize: PREVIEW_MAX_BYTES + 1 }))).toEqual({
      kind: null,
      reason: 'size',
    });
  });
});

describe('rich preview dialog', () => {
  it('plays video with controls and without autoplay from a blob URL', async () => {
    const dialog = await open(bin({ mimeType: 'video/mp4', fileName: 'clip.mp4' }));
    await waitFor(() => expect(dialog.querySelector('video')).not.toBeNull());
    const video = dialog.querySelector('video')!;
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(video.autoplay).toBe(false);
    expect(video.getAttribute('src')).toMatch(/^blob:/);
  });

  it('revokes the video URL when the dialog closes', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const dialog = await open(bin({ mimeType: 'video/webm', fileName: 'clip.webm' }));
    await waitFor(() => expect(dialog.querySelector('video')).not.toBeNull());
    const src = dialog.querySelector('video')!.getAttribute('src');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(revoke).toHaveBeenCalledWith(src);
  });

  it('shows JSON as the run data tree with three levels open', async () => {
    const value = { level1: { level2: { level3: { level4: 'deep' } } }, name: 'Ada' };
    const dialog = await open(
      bin({ mimeType: 'application/json', fileName: 'data.json', data: b64(JSON.stringify(value)) }),
    );
    expect(await within(dialog).findByText('"Ada"')).toBeTruthy();
    expect(within(dialog).getByText(/"level3"/)).toBeTruthy();
    // depth 0, 1 and 2 are open; level3's object (depth 3) is collapsed
    expect(within(dialog).queryByText(/"level4"/)).toBeNull();
    expect(within(dialog).getByText(/1 keys/)).toBeTruthy();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Expand' })[0]);
    expect(within(dialog).getByText('"deep"')).toBeTruthy();
  });

  it('caps the JSON tree it mounts: a wide nested file opens fewer levels', async () => {
    // 25 x 25 x 25 numbers: three open levels would mount over 16 000 nodes
    const cube = Array.from({ length: 25 }, () => Array.from({ length: 25 }, () => Array(25).fill(7)));
    const { container } = render(
      <RichPreview
        binary={bin({ mimeType: 'application/json', fileName: 'cube.json' })}
        blob={new Blob([JSON.stringify(cube)], { type: 'application/json' })}
      />,
    );
    await waitFor(() => expect(container.querySelector('button')).not.toBeNull());
    expect(container.querySelectorAll('div').length).toBeLessThan(2500);
    // the first two levels are open, the third is collapsed and opens on a click
    expect(screen.getAllByText(/25 items/).length).toBe(625);
    // leaf values (depth 3) are not mounted until their array opens
    const leaves = () =>
      [...container.querySelectorAll('span')].filter((el) => el.textContent === '7').length;
    expect(leaves()).toBe(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand' })[0]);
    expect(leaves()).toBe(25);
  });

  it('shows invalid JSON as text', async () => {
    const dialog = await open(bin({ mimeType: 'text/json', fileName: 'broken.json', data: b64('{"a": ') }));
    expect(await within(dialog).findByText(/not valid JSON/)).toBeTruthy();
    expect(dialog.querySelector('pre')?.textContent).toBe('{"a": ');
  });

  it('renders markdown as elements, with raw HTML and images as text', async () => {
    const source =
      '# Notes\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<img src=x onerror=alert(1)>\n\n![logo](https://example.com/logo.png)';
    const dialog = await open(bin({ mimeType: 'text/markdown', fileName: 'notes.md', data: b64(source) }));
    expect((await within(dialog).findByRole('heading', { name: 'Notes' })).tagName).toBe('H1');
    expect(within(dialog).getByRole('table')).toBeTruthy();
    expect(dialog.querySelector('img')).toBeNull();
    expect(dialog.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(dialog.textContent).toContain('![logo](https://example.com/logo.png)');
  });

  it('shows HTML in a sandboxed srcdoc iframe that starts with the CSP meta', async () => {
    const html =
      '<h1 onclick="alert(1)">Page</h1><script>alert(2)</script><a href="https://example.com">x</a>';
    const dialog = await open(bin({ mimeType: 'text/html', fileName: 'page.html', data: b64(html) }));
    const frame = await within(dialog).findByTitle('page.html');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.hasAttribute('src')).toBe(false);
    expect(frame.hasAttribute('allow')).toBe(false);
    expect([...frame.attributes].some((a) => a.name.startsWith('allow'))).toBe(false);
    const srcdoc = frame.getAttribute('srcdoc')!;
    expect(srcdoc.startsWith(CSP_META)).toBe(true);
    expect(srcdoc).toContain('<h1>Page</h1>');
    expect(srcdoc).not.toMatch(/<script|onclick|href=/i);
  });

  it('never picks the renderer from fileType: fileType image with mime text/html is the HTML frame', async () => {
    const dialog = await open(
      bin({ mimeType: 'text/html', fileType: 'image', fileName: 'trick.png', data: b64('<b>hi</b>') }),
    );
    const frame = await within(dialog).findByTitle('trick.png');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(dialog.querySelector('img')).toBeNull();
  });

  it('shows other text in a pre block', async () => {
    const dialog = await open(
      bin({ mimeType: 'text/csv', fileName: 'rows.csv', data: b64('a,b\n1,<b>2</b>') }),
    );
    await waitFor(() => expect(dialog.querySelector('pre')).not.toBeNull());
    expect(dialog.querySelector('pre')!.textContent).toBe('a,b\n1,<b>2</b>');
    expect(dialog.querySelector('b')).toBeNull();
  });

  it('keeps a 25 MB HTML file to Download only', () => {
    show(
      bin({
        mimeType: 'text/html',
        fileName: 'huge.html',
        data: '',
        id: 'fs:t/e/9',
        fileSize: 25 * 1024 * 1024 + 1,
      }),
    );
    const card = screen.getByRole('group', { name: 'huge.html' });
    expect(within(card).queryByRole('button', { name: 'View' })).toBeNull();
    expect(within(card).getByText(/too large to preview/i)).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Download' })).toBeTruthy();
  });

  it('decodes UTF-8 text', async () => {
    render(
      <RichPreview
        binary={bin({ mimeType: 'text/plain', fileName: 'u.txt' })}
        blob={new Blob(['café ✓'], { type: 'text/plain' })}
      />,
    );
    expect(await screen.findByText('café ✓')).toBeTruthy();
  });
});

describe('markdown additions', () => {
  it('renders fenced code, blockquote, rule, table alignment and strikethrough', () => {
    const { container } = render(
      <Markdown
        source={
          '```js\nconst a = 1 < 2;\n**not bold**\n```\n> quoted **text**\n> more\n\n---\n| Left | Right |\n|:--|--:|\n| x | ~~y~~ |\n\n~~gone~~ kept'
        }
      />,
    );
    const code = container.querySelector('pre code');
    expect(code?.textContent).toBe('const a = 1 < 2;\n**not bold**');
    expect(container.querySelector('pre strong')).toBeNull();
    const quote = container.querySelector('blockquote');
    expect(quote?.textContent).toContain('quoted text');
    expect(quote?.querySelector('strong')?.textContent).toBe('text');
    expect(container.querySelector('hr')).not.toBeNull();
    const headers = [...container.querySelectorAll('th')].map((th) => th.textContent);
    expect(headers).toEqual(['Left', 'Right']);
    const cells = container.querySelectorAll('td');
    expect(cells[1].style.textAlign).toBe('right');
    expect(cells[1].querySelector('del')?.textContent).toBe('y');
    expect([...container.querySelectorAll('del')].map((d) => d.textContent)).toEqual(['y', 'gone']);
  });

  it('parses inline markup in linear time: long lines of [ and ![ do not freeze the tab', () => {
    for (const line of [
      '['.repeat(100_000),
      '!['.repeat(50_000),
      '[a]('.repeat(25_000),
      '![a]('.repeat(20_000),
    ]) {
      const started = performance.now();
      const { container, unmount } = render(<Markdown source={line} />);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(container.textContent).toBe(line);
      unmount();
    }
  });

  it('still renders links and images as before', () => {
    const { container } = render(
      <Markdown source="see [docs](https://example.com/a_(b)) and ![logo](https://example.com/l.png) [x](javascript:alert(1))" />,
    );
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/a_(b');
    expect(link?.textContent).toBe('docs');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('![logo](https://example.com/l.png)');
    expect(container.querySelectorAll('a')).toHaveLength(1);
  });

  it('keeps deep blockquote nesting bounded', () => {
    const { container } = render(<Markdown source={`${'>'.repeat(5000)} deep`} />);
    expect(container.querySelectorAll('blockquote').length).toBeLessThanOrEqual(8);
    expect(container.textContent).toContain('deep');
  });
});
