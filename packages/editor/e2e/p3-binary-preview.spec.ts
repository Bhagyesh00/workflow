/**
 * P3-08 binary previews against the built editor served by the server, under its real CSP (not
 * run by the lane builders; run with E2E_BASE_URL=http://localhost:5678). A workflow turns base64
 * strings into a PNG, a WAV and a PDF; the output pane shows a card for each, and View opens the
 * image, the audio player (no autoplay) and the PDF frame from blob: URLs. CSP violations are
 * collected so the run can report whether `object-src 'none'` blocks the browser PDF viewer.
 */
import { expect, test } from '@playwright/test';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** 0.1 s of 8 kHz mono 8-bit silence as a WAV file */
function wavBase64(): string {
  const samples = 800;
  const buffer = Buffer.alloc(44 + samples, 0x80);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(8000, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples, 40);
  return buffer.toString('base64');
}

function pdfBase64(): string {
  const objects = [
    '1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj\n',
    '2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj\n',
    '3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 200 200]>> endobj\n',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(body.length);
    body += object;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer <</Size ${objects.length + 1} /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1').toString('base64');
}

function convert(id: string, name: string, source: string, property: string, fileName: string, x: number) {
  return {
    id,
    name,
    type: 'core.convertToFile',
    typeVersion: 1,
    position: [x, 0],
    parameters: {
      operation: 'toBinary',
      mode: 'each',
      sourceProperty: source,
      binaryPropertyName: property,
      options: { fileName },
    },
  };
}

test('PNG, WAV and PDF previews under the real CSP', async ({ page }) => {
  const id = Date.now().toString(36);
  const cspViolations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) cspViolations.push(message.text());
  });

  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Owner Olive');
  await page.getByLabel('Work email').fill(`binary-${id}@example.com`);
  await page.getByLabel('Password').fill(`binary-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Binary ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/workflows$/);

  const json = JSON.stringify({
    png: `data:image/png;base64,${PNG_1X1}`,
    wav: `data:audio/wav;base64,${wavBase64()}`,
    pdf: `data:application/pdf;base64,${pdfBase64()}`,
  });
  // the server's CSRF check wants the app origin on cookie-authenticated writes
  const created = await page.request.post('/rest/workflows', {
    headers: { origin: new URL(page.url()).origin },
    data: {
      name: `Binary previews ${id}`,
      nodes: [
        {
          id: 'n1',
          name: 'Start',
          type: 'core.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          id: 'n2',
          name: 'Fields',
          type: 'core.set',
          typeVersion: 1,
          position: [220, 0],
          parameters: { mode: 'raw', jsonOutput: json, includeOtherFields: false },
        },
        convert('n3', 'Make PNG', 'png', 'image', 'pixel.png', 440),
        convert('n4', 'Make WAV', 'wav', 'sound', 'tone.wav', 660),
        convert('n5', 'Make PDF', 'pdf', 'document', 'page.pdf', 880),
      ],
      connections: {
        Start: { main: [[{ node: 'Fields', type: 'main', index: 0 }]] },
        Fields: { main: [[{ node: 'Make PNG', type: 'main', index: 0 }]] },
        'Make PNG': { main: [[{ node: 'Make WAV', type: 'main', index: 0 }]] },
        'Make WAV': { main: [[{ node: 'Make PDF', type: 'main', index: 0 }]] },
      },
    },
  });
  expect(created.ok()).toBe(true);
  const workflowId = ((await created.json()) as { data: { id: string } }).data.id;

  await page.goto(`/workflow/${workflowId}`);
  await page.getByRole('button', { name: 'Execute workflow' }).click();
  await expect(page.getByText('Succeeded').first()).toBeVisible({ timeout: 30_000 });

  await page.locator('.react-flow__node', { hasText: 'Make PDF' }).dblclick();
  const output = page.getByRole('dialog', { name: /details$/ }).getByRole('region', { name: 'Output' });

  // PNG: thumbnail on the card, full image in the dialog
  const pngCard = output.getByRole('group', { name: 'pixel.png' });
  await expect(pngCard.getByRole('img', { name: 'pixel.png' })).toHaveAttribute('src', /^blob:/);
  await pngCard.getByRole('button', { name: 'View' }).click();
  let preview = page.getByRole('dialog', { name: 'pixel.png' });
  const image = preview.getByRole('img', { name: 'pixel.png' });
  await expect(image).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
  await preview.getByRole('button', { name: 'Close' }).click();

  // WAV: native player, no autoplay, loads its metadata
  await output.getByRole('group', { name: 'tone.wav' }).getByRole('button', { name: 'View' }).click();
  preview = page.getByRole('dialog', { name: 'tone.wav' });
  const audio = preview.locator('audio');
  await expect(audio).toHaveAttribute('src', /^blob:/);
  await expect(audio).toHaveAttribute('controls', '');
  expect(await audio.evaluate((el) => (el as HTMLAudioElement).autoplay)).toBe(false);
  await expect.poll(() => audio.evaluate((el) => (el as HTMLAudioElement).readyState)).toBeGreaterThan(0);
  expect(await audio.evaluate((el) => (el as HTMLAudioElement).paused)).toBe(true);
  await preview.getByRole('button', { name: 'Close' }).click();

  // PDF: a frame from a blob: URL, without sandbox (Chromium's PDF viewer never runs in a
  // sandboxed frame); the %PDF- check and the application/pdf blob type keep it a PDF
  await output.getByRole('group', { name: 'page.pdf' }).getByRole('button', { name: 'View' }).click();
  preview = page.getByRole('dialog', { name: 'page.pdf' });
  const frame = preview.locator('iframe');
  await expect(frame).toHaveAttribute('src', /^blob:/);
  await expect(frame).not.toHaveAttribute('sandbox');
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  await page.waitForTimeout(1500);
  // report for the end checks (plan note 5): any CSP refusal while the PDF loaded
  test.info().annotations.push({
    type: 'csp-violations',
    description: cspViolations.length ? cspViolations.join('\n') : 'none',
  });
  expect(cspViolations.filter((text) => /media-src|img-src|frame-src/.test(text))).toEqual([]);
  await preview.getByRole('button', { name: 'Close' }).click();
});
