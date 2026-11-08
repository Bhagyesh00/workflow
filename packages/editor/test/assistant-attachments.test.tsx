/**
 * P5-74 (L11): the attachment picker. Pick files, chips with a remove button, the size and type warning
 * before anything is sent, and the send body (base64 data, MIME type, file name) from the composer.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AssistantSendMessage } from '@workflow/workflow';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AssistantComposer } from '../src/components/assistant/AssistantComposer';
import { AttachmentPicker } from '../src/components/assistant/AttachmentPicker';
import { attachmentProblem, readAttachments } from '../src/features/assistant/attachments';

const file = (name: string, content: string | Uint8Array<ArrayBuffer>, type = '') =>
  new File([content], name, { type });

function Harness({ initial = [] as File[] }: { initial?: File[] }) {
  const [files, setFiles] = useState<File[]>(initial);
  return <AttachmentPicker files={files} onChange={setFiles} />;
}

const input = () => screen.getByTestId('assistant-file-input') as HTMLInputElement;

describe('AttachmentPicker (P5-74)', () => {
  it('picks files and shows a chip with the name and size for each', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole('list', { name: 'Attached files' })).toBeNull();
    await user.upload(input(), [file('report.pdf', new Uint8Array(2048), 'application/pdf'), file('data.csv', 'a,b\n1,2', 'text/csv')]);
    const chips = screen.getByRole('list', { name: 'Attached files' });
    expect(chips.textContent).toContain('report.pdf');
    expect(chips.textContent).toContain('2 KB');
    expect(chips.textContent).toContain('data.csv');
    expect(chips.textContent).toContain('7 B');
    expect(screen.queryByRole('alert')).toBeNull();
    // a second pick adds to the list
    await user.upload(input(), file('more.txt', 'hi', 'text/plain'));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('removes a chip with its button', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[file('a.txt', 'a', 'text/plain'), file('b.txt', 'b', 'text/plain')]} />);
    await user.click(screen.getByRole('button', { name: 'Remove a.txt' }));
    expect(screen.queryByText('a.txt')).toBeNull();
    expect(screen.getByText('b.txt')).toBeTruthy();
  });

  it('warns about a file that is too large before anything is sent', () => {
    const big = file('huge.pdf', new Uint8Array(8 * 1024 * 1024), 'application/pdf');
    render(<Harness initial={[big]} />);
    expect(screen.getByRole('alert').textContent).toBe('"huge.pdf" is too large: a file can be at most 7.5 MB');
  });

  it('warns about a type that cannot be attached and about more than 10 files', async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<Harness />);
    await user.upload(input(), file('tool.exe', 'MZ', 'application/x-msdownload'));
    expect(screen.getByRole('alert').textContent).toBe('"tool.exe" is a type of file that cannot be attached');
    await user.click(screen.getByRole('button', { name: 'Remove tool.exe' }));
    expect(screen.queryByRole('alert')).toBeNull();

    await user.upload(
      input(),
      Array.from({ length: 11 }, (_, i) => file(`f${i}.txt`, 'x', 'text/plain')),
    );
    expect(screen.getByRole('alert').textContent).toBe('You can attach at most 10 files to one message');
  });

  it('warns when the files are too large together', () => {
    const files = Array.from({ length: 4 }, (_, i) => file(`p${i}.pdf`, new Uint8Array(4 * 1024 * 1024), 'application/pdf'));
    expect(attachmentProblem(files)).toBe('The files are too large together: one message can carry at most 12 MB');
  });
});

describe('readAttachments (P5-74)', () => {
  it('gives [] for no files and the body shape for files', async () => {
    expect(await readAttachments([])).toEqual([]);
    const list = await readAttachments([file('a.csv', 'a,b', 'text/csv'), file('notes.md', '# hi', '')]);
    expect(list).toEqual([
      { data: btoa('a,b'), mimeType: 'text/csv', fileName: 'a.csv' },
      { data: btoa('# hi'), mimeType: 'text/markdown', fileName: 'notes.md' },
    ]);
  });

  it('uses the extension when the browser names another type, and refuses what cannot go', async () => {
    const [csv] = await readAttachments([file('sheet.csv', 'x', 'application/vnd.ms-excel')]);
    expect(csv?.mimeType).toBe('text/csv');
    await expect(readAttachments([file('a.exe', 'MZ')])).rejects.toThrow('cannot be attached');
  });
});

describe('AssistantComposer with files (P5-74)', () => {
  it('sends the message with the files as the body, then clears the chips', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn<(body: AssistantSendMessage) => void>();
    render(<AssistantComposer running={false} onSend={onSend} onStop={() => {}} />);
    await user.type(screen.getByLabelText('Message'), 'Read this');
    await user.upload(input(), file('a.csv', 'a,b', 'text/csv'));
    expect(screen.getByText('a.csv')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith({
      message: 'Read this',
      attachments: [{ data: btoa('a,b'), mimeType: 'text/csv', fileName: 'a.csv' }],
    });
    await waitFor(() => expect(screen.queryByText('a.csv')).toBeNull());
  });

  it('sends no attachments key without files, and keeps the chips when a file cannot go', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const onSend = vi.fn<(body: AssistantSendMessage) => void>();
    render(<AssistantComposer running={false} onSend={onSend} onStop={() => {}} />);
    await user.type(screen.getByLabelText('Message'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ message: 'Hello' }));

    await user.type(screen.getByLabelText('Message'), 'Again');
    await user.upload(input(), file('tool.exe', 'MZ', 'application/x-msdownload'));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.getByText('tool.exe')).toBeTruthy();
  });
});
