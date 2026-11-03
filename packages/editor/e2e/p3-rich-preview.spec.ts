/**
 * P3-14 rich previews against the built editor served by the server, under its real CSP (not run
 * by the lane builders; run with E2E_BASE_URL=http://localhost:5678). A workflow turns base64
 * strings into an HTML page, a JSON file, a markdown file, a CSV file and a video; the output pane
 * shows a card for each and View opens the preview.
 *
 * The HTML checks are the behaviour the unit tests cannot show: the frame is an opaque origin (the
 * editor cannot reach into it, so it cannot reach the editor), no script runs, the remote image,
 * `@import` and `url(https:)` never load, and a clicked link does not navigate.
 */
import { expect, type Page, test } from '@playwright/test';

/** a host that must never be requested; .invalid never resolves, so a request would only show as an attempt */
const PROBE_HOST = 'rich-preview-probe.invalid';

const HTML = `<!doctype html>
<html>
<head>
  <title>Report</title>
  <style>
    @import url(https://${PROBE_HOST}/import.css);
    .remote { background-image: url(https://${PROBE_HOST}/bg.png); }
  </style>
  <script>parent.document.title = 'owned'; window.top.location = 'https://${PROBE_HOST}/top';</script>
</head>
<body onload="document.getElementById('marker').textContent = 'ran'">
  <h1 style="color: rgb(0, 128, 0)">Quarterly report</h1>
  <p id="marker">static</p>
  <p class="remote">Remote background</p>
  <img id="remote-img" src="https://${PROBE_HOST}/pixel.png" alt="remote">
  <a id="link" href="https://${PROBE_HOST}/link" target="_top">Open the report site</a>
  <form action="https://${PROBE_HOST}/form"><button id="submit">Send</button></form>
</body>
</html>`;

const JSON_FILE = JSON.stringify({
  customer: { name: 'Ada', address: { city: 'London', geo: { lat: 51.5 } } },
});

const MARKDOWN = [
  '# Release notes',
  '',
  '| Item | State |',
  '|:--|--:|',
  '| Previews | ~~planned~~ done |',
  '',
  '<img src=x onerror="document.title = \'owned\'">',
  '',
  `![remote](https://${PROBE_HOST}/md.png)`,
].join('\n');

const CSV = 'name,score\nAda,<b>10</b>\n';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

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

async function openPreview(page: Page, fileName: string) {
  const output = page.getByRole('dialog', { name: /details$/ }).getByRole('region', { name: 'Output' });
  await output.getByRole('group', { name: fileName }).getByRole('button', { name: 'View' }).click();
  return page.getByRole('dialog', { name: fileName });
}

test('video, JSON, markdown, text and sandboxed HTML previews under the real CSP', async ({ page }) => {
  const id = Date.now().toString(36);
  const probeRequests: string[] = [];
  const cspViolations: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(PROBE_HOST)) probeRequests.push(request.url());
  });
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) cspViolations.push(message.text());
  });

  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Owner Olive');
  await page.getByLabel('Work email').fill(`rich-${id}@example.com`);
  await page.getByLabel('Password').fill(`rich-pass-${id}1`);
  await page.getByLabel('Workspace name').fill(`Rich ${id}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/workflows$/);

  const json = JSON.stringify({
    html: `data:text/html;base64,${b64(HTML)}`,
    json: `data:application/json;base64,${b64(JSON_FILE)}`,
    md: `data:text/markdown;base64,${b64(MARKDOWN)}`,
    csv: `data:text/csv;base64,${b64(CSV)}`,
    // not a playable file: the check is the element, not playback
    video: `data:video/mp4;base64,${b64('not a real video')}`,
  });
  const created = await page.request.post('/rest/workflows', {
    data: {
      name: `Rich previews ${id}`,
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
        convert('n3', 'Make HTML', 'html', 'page', 'report.html', 440),
        convert('n4', 'Make JSON', 'json', 'payload', 'customer.json', 660),
        convert('n5', 'Make MD', 'md', 'notes', 'notes.md', 880),
        convert('n6', 'Make CSV', 'csv', 'table', 'scores.csv', 1100),
        convert('n7', 'Make Video', 'video', 'clip', 'clip.mp4', 1320),
      ],
      connections: {
        Start: { main: [[{ node: 'Fields', type: 'main', index: 0 }]] },
        Fields: { main: [[{ node: 'Make HTML', type: 'main', index: 0 }]] },
        'Make HTML': { main: [[{ node: 'Make JSON', type: 'main', index: 0 }]] },
        'Make JSON': { main: [[{ node: 'Make MD', type: 'main', index: 0 }]] },
        'Make MD': { main: [[{ node: 'Make CSV', type: 'main', index: 0 }]] },
        'Make CSV': { main: [[{ node: 'Make Video', type: 'main', index: 0 }]] },
      },
    },
  });
  expect(created.ok()).toBe(true);
  const workflowId = ((await created.json()) as { data: { id: string } }).data.id;

  await page.goto(`/workflow/${workflowId}`);
  await page.getByRole('button', { name: 'Execute workflow' }).click();
  await expect(page.getByText('Succeeded').first()).toBeVisible({ timeout: 30_000 });
  const editorUrl = page.url();
  const editorTitle = await page.title();

  await page.locator('.react-flow__node', { hasText: 'Make Video' }).dblclick();

  // HTML: sandboxed srcdoc frame, opaque origin, no script, no network, no navigation
  let preview = await openPreview(page, 'report.html');
  const frameElement = preview.locator('iframe');
  await expect(frameElement).toHaveAttribute('sandbox', '');
  await expect(frameElement).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(await frameElement.getAttribute('src')).toBeNull();
  const frame = preview.frameLocator('iframe');
  await expect(frame.getByRole('heading', { name: 'Quarterly report' })).toBeVisible();
  await expect(frame.getByRole('heading', { name: 'Quarterly report' })).toHaveCSS('color', 'rgb(0, 128, 0)');
  await expect(frame.locator('#marker')).toHaveText('static');
  // opaque origin: the editor cannot read the frame's document, so the frame cannot read the editor's
  expect(
    await frameElement.evaluate((el) => {
      try {
        return (el as HTMLIFrameElement).contentDocument === null;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  expect(
    await frameElement.evaluate((el) => {
      try {
        void (el as HTMLIFrameElement).contentWindow?.document;
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  // the remote image never loaded
  expect(await frame.locator('#remote-img').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(0);
  // a click on the (stripped) link and the (stripped) form go nowhere
  await frame.getByText('Open the report site').click();
  await frame.getByRole('button', { name: 'Send' }).click();
  await page.waitForTimeout(1000);
  expect(page.url()).toBe(editorUrl);
  expect(await page.title()).toBe(editorTitle);
  await expect(frame.getByRole('heading', { name: 'Quarterly report' })).toBeVisible();
  await preview.getByRole('button', { name: 'Close' }).click();

  // JSON: the run data tree, three levels open
  preview = await openPreview(page, 'customer.json');
  await expect(preview.getByText('"London"')).toBeVisible();
  await expect(preview.getByText(/"lat"/)).toHaveCount(0);
  await preview.getByRole('button', { name: 'Close' }).click();

  // markdown: elements, raw HTML and images as text
  preview = await openPreview(page, 'notes.md');
  await expect(preview.getByRole('heading', { name: 'Release notes', level: 1 })).toBeVisible();
  await expect(preview.getByRole('table')).toBeVisible();
  await expect(preview.locator('del')).toHaveText('planned');
  await expect(preview.locator('img')).toHaveCount(0);
  await expect(preview.getByText(`![remote](https://${PROBE_HOST}/md.png)`)).toBeVisible();
  await preview.getByRole('button', { name: 'Close' }).click();

  // other text: a pre block, markup as text
  preview = await openPreview(page, 'scores.csv');
  await expect(preview.locator('pre')).toBeVisible();
  expect(await preview.locator('pre').textContent()).toBe(CSV);
  await expect(preview.locator('b')).toHaveCount(0);
  await preview.getByRole('button', { name: 'Close' }).click();

  // video: native player from a blob: URL, no autoplay
  preview = await openPreview(page, 'clip.mp4');
  const video = preview.locator('video');
  await expect(video).toHaveAttribute('src', /^blob:/);
  await expect(video).toHaveAttribute('controls', '');
  expect(await video.evaluate((el) => (el as HTMLVideoElement).autoplay)).toBe(false);
  await preview.getByRole('button', { name: 'Close' }).click();

  expect(await page.title()).toBe(editorTitle);
  expect(probeRequests).toEqual([]);
  test.info().annotations.push({
    type: 'csp-violations',
    description: cspViolations.length ? cspViolations.join('\n') : 'none',
  });
});
