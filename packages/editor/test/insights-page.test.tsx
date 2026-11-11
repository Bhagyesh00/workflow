/**
 * P6-57 (L13): the Insights page on the demo backend: the tiles equal what the route answers, a range or project
 * change refetches, sort and paging send their query, the empty state, the hints, the 7-day strip on the
 * Overview, and a member neither sees the link nor the page (nor sends a request).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { type ApiRequest, fetchTransport, setTransport } from '../src/api/client';
import type { InsightsSummary, InsightsSummaryType } from '../src/api/types';
import {
  changeTone,
  formatChange,
  formatMetric,
  SummaryStrip,
} from '../src/components/insights/SummaryStrip';
import { backend, signedIn } from './backend';
import { renderApp, withProviders } from './utils';

const T = { timeout: 20_000 };
const DAY = 24 * 3_600_000;

/** every request the page sends, in order */
function record(): ApiRequest[] {
  const seen: ApiRequest[] = [];
  setTransport(async (request) => {
    seen.push(request);
    return fetchTransport(request);
  });
  return seen;
}

const insightRequests = (seen: ApiRequest[], path: string) => seen.filter((r) => r.path === path);

function seed(count: number, settings = {}) {
  return Array.from({ length: count }, (_, i) =>
    backend().seedWorkflow({ name: `Flow ${String(i + 1).padStart(2, '0')}`, settings }),
  );
}

async function summaryFor(request: ApiRequest): Promise<InsightsSummary> {
  const query = Object.fromEntries(Object.entries(request.query ?? {}).map(([k, v]) => [k, String(v)]));
  const res = await backend().handle({ method: 'GET', path: '/insights/summary', query });
  return (res.body as { data: InsightsSummary }).data;
}

afterEach(() => setTransport(fetchTransport));

describe('Insights page', () => {
  it('shows tiles equal to what the summary route answers, and names the manual runs hint', async () => {
    signedIn();
    seed(3, { timeSavedMode: 'fixed', timeSavedPerExecution: 5 });
    const seen = record();
    renderApp('/insights');

    const total = await screen.findByTestId('insights-tile-total-value', {}, T);
    await waitFor(() => expect(total.textContent).not.toBe('0'), T);
    const request = insightRequests(seen, '/insights/summary')[0];
    const expected = await summaryFor(request);
    expect(expected.total.value).toBeGreaterThan(0);
    for (const type of ['total', 'failed', 'failureRate', 'timeSaved', 'averageRunTime'] as const) {
      expect(screen.getByTestId(`insights-tile-${type}-value`).textContent).toBe(
        formatMetric(type, expected[type]),
      );
    }
    expect(screen.getByRole('heading', { name: 'Insights' })).toBeTruthy();
    expect(screen.getAllByText(/Manual executions aren't counted\./).length).toBeGreaterThan(0);
    // the tile of the chart on show is the one marked
    expect(screen.getByRole('link', { name: /Production executions/ }).getAttribute('aria-current')).toBe(
      'true',
    );
  });

  it('links a tile to its chart and shows that chart', async () => {
    const user = userEvent.setup();
    signedIn();
    seed(2);
    renderApp('/insights');
    await screen.findByTestId('insights-tile-total-value', {}, T);
    expect((await screen.findByTestId('insights-chart', {}, T)).getAttribute('data-kind')).toBe('bar');
    await user.click(screen.getByRole('link', { name: /Failure rate/ }));
    expect(await screen.findByRole('figure', { name: 'Failure rate chart' }, T)).toBeTruthy();
    expect(screen.getByTestId('insights-chart').getAttribute('data-kind')).toBe('line');
  });

  it('reads the time saved chart from its own route', async () => {
    signedIn();
    seed(2, { timeSavedPerExecution: 10 });
    const seen = record();
    renderApp('/insights/timeSaved');
    await screen.findByTestId('insights-chart', {}, T);
    expect(insightRequests(seen, '/insights/by-time/time-saved').length).toBeGreaterThan(0);
    expect(insightRequests(seen, '/insights/by-time')).toHaveLength(0);
  });

  it('refetches when the range changes', async () => {
    const user = userEvent.setup();
    signedIn();
    seed(2);
    const seen = record();
    renderApp('/insights');
    await screen.findByTestId('insights-tile-total-value', {}, T);
    const before = insightRequests(seen, '/insights/summary');
    expect(before).toHaveLength(1);
    const span = (r: ApiRequest) =>
      Date.parse(String(r.query?.endDate)) - Date.parse(String(r.query?.startDate));
    expect(Math.round(span(before[0]) / DAY)).toBe(7);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Date range' }), 'month');
    await waitFor(() => expect(insightRequests(seen, '/insights/summary')).toHaveLength(2), T);
    expect(Math.round(span(insightRequests(seen, '/insights/summary')[1]) / DAY)).toBe(30);
    expect(insightRequests(seen, '/insights/by-workflow').length).toBeGreaterThan(1);
    expect(insightRequests(seen, '/insights/by-time').length).toBeGreaterThan(1);
    // the demo's first data day is 40 days back: a quarter reaches before it
    expect(screen.queryByText('Part of this range has no data')).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Date range' }), 'quarter');
    expect(await screen.findByText('Part of this range has no data', {}, T)).toBeTruthy();
  });

  it('narrows to a project from the project filter', async () => {
    const user = userEvent.setup();
    const b = signedIn();
    const tenantId = b.session!.tenantId;
    const second = b.createProject({
      tenantId,
      name: 'Billing',
      type: 'team',
      creatorId: b.session!.userId,
    });
    b.seedWorkflow({ name: 'Invoices', projectId: second.id });
    seed(2);
    const seen = record();
    renderApp('/insights');
    await screen.findByText('Invoices', {}, T);
    expect(insightRequests(seen, '/insights/summary')[0].query?.projectId).toBeUndefined();

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Project' }), 'Billing');
    await waitFor(
      () => expect(insightRequests(seen, '/insights/summary').at(-1)?.query?.projectId).toBe(second.id),
      T,
    );
    await waitFor(() => expect(screen.queryByText('Flow 01')).toBeNull(), T);
    expect(screen.getByText('Invoices')).toBeTruthy();
  });

  it('lists workflows with a link, and sorts by a header, the same column again turning the order round', async () => {
    const user = userEvent.setup();
    signedIn();
    const [first] = seed(3);
    const seen = record();
    renderApp('/insights');
    const link = await screen.findByRole('link', { name: 'Flow 01' }, T);
    expect(link.getAttribute('href')).toBe(`/workflow/${first.id}`);
    expect(insightRequests(seen, '/insights/by-workflow')[0].query?.sortBy).toBe('total:desc');

    const table = screen.getByRole('table', { name: 'Executions by workflow' });
    await user.click(within(table).getByRole('button', { name: 'Failed' }));
    await waitFor(
      () => expect(insightRequests(seen, '/insights/by-workflow').at(-1)?.query?.sortBy).toBe('failed:desc'),
      T,
    );
    await user.click(within(table).getByRole('button', { name: 'Failed' }));
    await waitFor(
      () => expect(insightRequests(seen, '/insights/by-workflow').at(-1)?.query?.sortBy).toBe('failed:asc'),
      T,
    );
    await user.click(within(table).getByRole('button', { name: 'Workflow' }));
    await waitFor(
      () =>
        expect(insightRequests(seen, '/insights/by-workflow').at(-1)?.query?.sortBy).toBe('workflowName:asc'),
      T,
    );
    await waitFor(
      () =>
        expect(
          within(screen.getByRole('table', { name: 'Executions by workflow' }))
            .getAllByRole('link')
            .map((a) => a.textContent),
        ).toEqual(['Flow 01', 'Flow 02', 'Flow 03']),
      T,
    );
    expect(
      within(screen.getByRole('table', { name: 'Executions by workflow' }))
        .getByRole('columnheader', { name: 'Workflow' })
        .getAttribute('aria-sort'),
    ).toBe('ascending');
  });

  it('pages with skip and take, and the size picker goes back to the first page', async () => {
    const user = userEvent.setup();
    signedIn();
    seed(12);
    const seen = record();
    renderApp('/insights');
    await screen.findByText('1-10 of 12', {}, T);
    const last = () => insightRequests(seen, '/insights/by-workflow').at(-1)?.query;
    expect(last()).toMatchObject({ skip: 0, take: 10 });
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('11-12 of 12', {}, T);
    expect(last()).toMatchObject({ skip: 10, take: 10 });
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Rows per page' }), '25');
    await screen.findByText('1-12 of 12', {}, T);
    expect(last()).toMatchObject({ skip: 0, take: 25 });
  });

  it('shows the empty state with no production executions', async () => {
    signedIn();
    renderApp('/insights');
    expect(await screen.findByText('No production executions in this period', {}, T)).toBeTruthy();
    expect((await screen.findByTestId('insights-tile-total-value', {}, T)).textContent).toBe('0');
    // no change to show when the earlier period has no runs either
    expect(screen.queryByTestId('insights-tile-total-change')).toBeNull();
    // no time estimate: the tile says what to do instead of a bare zero
    expect(screen.getAllByText(/No time estimate yet/).length).toBeGreaterThan(0);
  });

  it('does not show it to a member, and sends no insights request', async () => {
    signedIn();
    backend().setDemoRole('member');
    const seen = record();
    renderApp('/insights');
    expect(await screen.findByText("You don't have access to Insights", {}, T)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Insights' })).toBeNull();
    expect(seen.filter((r) => r.path.startsWith('/insights'))).toHaveLength(0);
  });
});

describe('7-day strip on the Overview', () => {
  it('shows the last 7 days to an owner, each tile a link to its chart', async () => {
    signedIn();
    seed(2);
    const seen = record();
    renderApp('/home/workflows');
    const strip = await screen.findByRole('region', { name: 'Last 7 days' }, T);
    await waitFor(
      () => expect(within(strip).getByTestId('insights-tile-total-value').textContent).not.toBe('0'),
      T,
    );
    const request = insightRequests(seen, '/insights/summary')[0];
    const days =
      (Date.parse(String(request.query?.endDate)) - Date.parse(String(request.query?.startDate))) / DAY;
    expect(Math.round(days)).toBe(7);
    const expected = await summaryFor(request);
    expect(within(strip).getByTestId('insights-tile-failed-value').textContent).toBe(
      formatMetric('failed', expected.failed),
    );
    expect(
      within(strip)
        .getByRole('link', { name: /Time saved/ })
        .getAttribute('href'),
    ).toBe('/insights/timeSaved');
  });

  it('is not there for a member, which sends no request', async () => {
    signedIn();
    backend().setDemoRole('member');
    const seen = record();
    renderApp('/home/workflows');
    await screen.findAllByRole('link', { name: 'Settings' }, T);
    expect(screen.queryByRole('region', { name: 'Last 7 days' })).toBeNull();
    expect(seen.filter((r) => r.path.startsWith('/insights'))).toHaveLength(0);
  });
});

describe('tile text', () => {
  const metric = (
    value: number,
    deviation: number | null,
    unit: 'count' | 'ratio' | 'minute' | 'millisecond',
  ) => ({
    value,
    deviation,
    unit,
  });

  it('turns minutes into hours at 60, milliseconds into seconds at 1000, and a ratio into percent', () => {
    expect(formatMetric('timeSaved', metric(45, null, 'minute'))).toBe('45 min');
    expect(formatMetric('timeSaved', metric(150, null, 'minute'))).toBe('2.5 h');
    expect(formatMetric('averageRunTime', metric(340, null, 'millisecond'))).toBe('340 ms');
    expect(formatMetric('averageRunTime', metric(1234, null, 'millisecond'))).toBe('1.23 s');
    expect(formatMetric('failureRate', metric(0.083, null, 'ratio'))).toBe('8.3%');
    expect(formatMetric('total', metric(1204, null, 'count'))).toBe('1,204');
  });

  it('says the change in percent for counts and in points for the failure rate', () => {
    expect(formatChange('total', metric(110, 10, 'count'))).toBe('+10%');
    expect(formatChange('failed', metric(5, -5, 'count'))).toBe('-50%');
    expect(formatChange('failureRate', metric(0.1, 0.015, 'ratio'))).toBe('+1.5 pp');
    expect(formatChange('failureRate', metric(0.1, -0.02, 'ratio'))).toBe('-2 pp');
    expect(formatChange('total', metric(10, null, 'count'))).toBeNull();
    // nothing before it: a percent of nothing is not shown
    expect(formatChange('total', metric(10, 10, 'count'))).toBeNull();
  });

  it('colours the change by whether it is good news', () => {
    const cases: Array<[InsightsSummaryType, number, 'good' | 'bad']> = [
      ['total', 3, 'good'],
      ['total', -3, 'bad'],
      ['timeSaved', 3, 'good'],
      ['failed', 3, 'bad'],
      ['failed', -3, 'good'],
      ['failureRate', 0.1, 'bad'],
      ['averageRunTime', -50, 'good'],
      ['averageRunTime', 50, 'bad'],
    ];
    for (const [type, deviation, tone] of cases) expect(changeTone(type, deviation)).toBe(tone);
    expect(changeTone('total', 0)).toBe('none');
    expect(changeTone('total', null)).toBe('none');
  });

  it('draws the change green or red in the tile', () => {
    const summary: InsightsSummary = {
      total: metric(110, 10, 'count'),
      failed: metric(8, 3, 'count'),
      failureRate: metric(0.07, 0.01, 'ratio'),
      timeSaved: metric(0, 0, 'minute'),
      averageRunTime: metric(500, -100, 'millisecond'),
    };
    withProviders(<SummaryStrip summary={summary} loading={false} />);
    expect(screen.getByTestId('insights-tile-total-change').className).toContain('text-ok');
    expect(screen.getByTestId('insights-tile-failed-change').className).toContain('text-err');
    expect(screen.getByTestId('insights-tile-failureRate-change').textContent).toBe('+1 pp');
    expect(screen.getByTestId('insights-tile-averageRunTime-change').className).toContain('text-ok');
  });
});
