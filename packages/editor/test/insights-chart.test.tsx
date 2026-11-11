/**
 * P6-57 (L13): the own SVG chart: one bucket per row, bars for counts and time, a line for the rate and the
 * average, axis labels, an empty state, and keyboard focus (one tab stop, arrows, Home and End).
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { InsightsByTimeRow } from '../src/api/types';
import { bucketLabel, InsightsChart } from '../src/components/insights/InsightsChart';

const DAY = 24 * 3_600_000;
const START = Date.UTC(2026, 2, 2);

function rows(values: number[], key: 'total' | 'failureRate' | 'timeSaved' = 'total'): InsightsByTimeRow[] {
  return values.map((value, i) => ({
    date: new Date(START + i * DAY).toISOString(),
    values: { [key]: value },
  }));
}

describe('InsightsChart', () => {
  it('draws one bar per bucket, the biggest one tallest', () => {
    const data = rows([2, 12, 5, 0, 7]);
    render(<InsightsChart type="total" data={data} granularity="day" />);
    const chart = screen.getByTestId('insights-chart');
    expect(chart.getAttribute('data-kind')).toBe('bar');
    const buckets = within(chart).getAllByTestId('insights-bucket');
    expect(buckets).toHaveLength(5);
    expect(chart.querySelector('polyline')).toBeNull();
    // the bar is the last rect of a bucket (the first is its hit area)
    const height = (i: number) => {
      const rects = buckets[i].querySelectorAll('rect');
      return Number(rects[rects.length - 1].getAttribute('height'));
    };
    expect(height(1)).toBeGreaterThan(height(2));
    expect(height(2)).toBeGreaterThan(height(0));
    expect(height(3)).toBe(0);
    expect(buckets[1].getAttribute('aria-label')).toBe(`${bucketLabel(data[1].date, 'day')}: 12`);
  });

  it('draws a line with a point per bucket for the failure rate, in percent', () => {
    const data = rows([0, 0.125, 0.8], 'failureRate');
    render(<InsightsChart type="failureRate" data={data} granularity="day" />);
    const chart = screen.getByTestId('insights-chart');
    expect(chart.getAttribute('data-kind')).toBe('line');
    const points = chart.querySelector('polyline')?.getAttribute('points')?.split(' ');
    expect(points).toHaveLength(3);
    expect(chart.querySelectorAll('circle')).toHaveLength(3);
    const buckets = within(chart).getAllByTestId('insights-bucket');
    expect(buckets[1].getAttribute('aria-label')).toContain('12.5%');
    // the axis tops out at 100% for a high rate (it never goes higher)
    const labels = Array.from(chart.querySelectorAll('text')).map((t) => t.textContent);
    expect(labels).toContain('100%');
    expect(labels).toContain('0%');
  });

  it('labels the axes: the top of the value axis is a round number, the days run along the bottom', () => {
    const data = rows([2, 12, 5]);
    render(<InsightsChart type="total" data={data} granularity="day" />);
    const labels = Array.from(screen.getByTestId('insights-chart').querySelectorAll('text')).map(
      (t) => t.textContent,
    );
    expect(labels).toContain('20');
    expect(labels).toContain('0');
    for (const row of data) expect(labels).toContain(bucketLabel(row.date, 'day'));
  });

  it('names a week by its first day and says time saved in hours from 60 minutes', () => {
    const data = rows([30, 90], 'timeSaved');
    render(<InsightsChart type="timeSaved" data={data} granularity="week" />);
    const buckets = screen.getAllByTestId('insights-bucket');
    expect(buckets[0].getAttribute('aria-label')).toBe(
      `Week of ${bucketLabel(data[0].date, 'week')}: 30 min`,
    );
    expect(buckets[1].getAttribute('aria-label')).toContain('1.5 h');
  });

  it('says so when there is no data', () => {
    render(<InsightsChart type="total" data={[]} granularity="day" />);
    expect(screen.getByText('No data for this period.')).toBeTruthy();
    expect(screen.queryByTestId('insights-chart')).toBeNull();
  });

  it('has one tab stop and moves between buckets with the arrow keys, Home and End', async () => {
    const user = userEvent.setup();
    const data = rows([3, 8, 1, 6]);
    render(<InsightsChart type="total" data={data} granularity="day" />);
    const buckets = screen.getAllByTestId('insights-bucket');
    expect(buckets.map((b) => b.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
    const caption = screen.getByTestId('insights-chart-caption');
    expect(caption.textContent).toBe('');

    await user.tab();
    expect(document.activeElement).toBe(buckets[0]);
    expect(caption.textContent).toBe(`${bucketLabel(data[0].date, 'day')}: 3`);

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(buckets[1]);
    expect(caption.textContent).toBe(`${bucketLabel(data[1].date, 'day')}: 8`);
    expect(buckets.map((b) => b.getAttribute('tabindex'))).toEqual(['-1', '0', '-1', '-1']);

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(buckets[3]);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(buckets[3]);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(buckets[2]);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(buckets[0]);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(buckets[0]);
  });

  it('names a bucket under the chart on hover too', async () => {
    const user = userEvent.setup();
    const data = rows([3, 8]);
    render(<InsightsChart type="total" data={data} granularity="day" />);
    const buckets = screen.getAllByTestId('insights-bucket');
    await user.hover(buckets[1]);
    expect(screen.getByTestId('insights-chart-caption').textContent).toBe(
      `${bucketLabel(data[1].date, 'day')}: 8`,
    );
    await user.unhover(buckets[1]);
    expect(screen.getByTestId('insights-chart-caption').textContent).toBe('');
  });
});
