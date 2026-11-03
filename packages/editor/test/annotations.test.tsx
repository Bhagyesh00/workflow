/** Execution annotations (P3-09): tags and rating on the detail page, badges and filters in the list. */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { AnnotationBadges } from '../src/components/executions/AnnotationBadges';
import { MAX_ANNOTATION_FILTER_TAGS } from '../src/components/executions/AnnotationFilters';
import { filterExecutionList } from '../src/demo/mock-annotations';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const LONG = { timeout: 20_000 };

const trigger: WorkflowNode = {
  id: 't',
  name: 'Start',
  type: 'core.manualTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

/** `count` finished runs of one workflow */
async function seedRuns(count: number) {
  const wf = backend().seedWorkflow({ name: 'Runner', nodes: [trigger], connections: {} });
  for (let i = 0; i < count; i++) {
    await backend().handle({ method: 'POST', path: `/workflows/${wf.id}/run`, body: {} });
    await waitFor(() =>
      expect(backend().executions.filter((e) => e.status !== 'running')).toHaveLength(i + 1),
    );
  }
  return backend().executions.slice();
}

async function makeTag(name: string) {
  const res = (await backend().handle({ method: 'POST', path: '/annotation-tags', body: { name } })) as {
    body: { data?: { id: string } } & { id?: string };
  };
  return (res.body.data?.id ?? res.body.id) as string;
}

const annotate = (id: string, body: Record<string, unknown>) =>
  backend().handle({ method: 'PATCH', path: `/executions/${id}`, body });

describe('AnnotationBadges', () => {
  it('shows nothing without an annotation, else the rating and the tags', () => {
    const { container, rerender } = render(<AnnotationBadges annotation={null} />);
    expect(container.textContent).toBe('');
    rerender(<AnnotationBadges annotation={{ vote: null, tags: [] }} />);
    expect(container.textContent).toBe('');
    rerender(<AnnotationBadges annotation={{ vote: 'up', tags: [{ id: 'a', name: 'billing' }] }} />);
    expect(screen.getByRole('img', { name: 'Rated good' })).toBeTruthy();
    expect(screen.getByText('billing')).toBeTruthy();
    rerender(<AnnotationBadges annotation={{ vote: 'down', tags: [] }} />);
    expect(screen.getByRole('img', { name: 'Rated bad' })).toBeTruthy();
  });
});

describe('filterExecutionList (demo)', () => {
  it('needs every tag and the vote', () => {
    const run = (id: string, vote: 'up' | 'down' | null, tags: string[]) =>
      ({ id, annotation: { vote, tags: tags.map((t) => ({ id: t, name: t })) } }) as never;
    const list = [
      run('1', 'up', ['a', 'b']),
      run('2', 'down', ['a']),
      { id: '3', annotation: null } as never,
    ];
    const ids = (q: Record<string, string>) =>
      filterExecutionList(null as never, list, q).map((e: { id: string }) => e.id);
    expect(ids({ annotationTags: 'a' })).toEqual(['1', '2']);
    expect(ids({ annotationTags: 'a,b' })).toEqual(['1']);
    expect(ids({ vote: 'down' })).toEqual(['2']);
    expect(ids({})).toEqual(['1', '2', '3']);
  });
});

describe('execution detail panel', () => {
  it('says "No annotation provided", then saves a rating and a tag', async () => {
    const user = userEvent.setup();
    signedIn();
    const [run] = await seedRuns(1);
    const tagId = await makeTag('billing');
    renderApp(`/executions/${run.id}`);
    const panel = await screen.findByRole('region', { name: 'Execution annotation' }, LONG);
    expect(within(panel).getByText('No annotation provided')).toBeTruthy();

    await user.click(within(panel).getByRole('button', { name: 'Good run' }));
    await waitFor(() => expect(backend().executions[0].annotation?.vote).toBe('up'));
    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: 'Good run' }).getAttribute('aria-pressed')).toBe(
        'true',
      ),
    );
    expect(within(panel).queryByText('No annotation provided')).toBeNull();

    await user.click(within(panel).getByRole('button', { name: /Edit annotation tags/ }));
    await user.click(await screen.findByRole('option', { name: 'billing' }));
    await waitFor(() => expect(backend().executions[0].annotation?.tags.map((t) => t.id)).toEqual([tagId]));
    expect(await within(panel).findByRole('button', { name: 'Remove tag billing' })).toBeTruthy();

    // the same thumb again clears the rating; removing the last tag clears the annotation
    await user.click(within(panel).getByRole('button', { name: 'Good run' }));
    await waitFor(() => expect(backend().executions[0].annotation?.vote).toBeNull());
    await user.click(await within(panel).findByRole('button', { name: 'Remove tag billing' }));
    await waitFor(() => expect(backend().executions[0].annotation).toBeNull());
    expect(await within(panel).findByText('No annotation provided')).toBeTruthy();
  });

  it('creates a new tag from the picker and attaches it', async () => {
    const user = userEvent.setup();
    signedIn();
    const [run] = await seedRuns(1);
    renderApp(`/executions/${run.id}`);
    const panel = await screen.findByRole('region', { name: 'Execution annotation' }, LONG);
    await user.click(within(panel).getByRole('button', { name: /Edit annotation tags/ }));
    await user.type(screen.getByLabelText('Find or create an annotation tag'), 'flaky{Enter}');
    await waitFor(() =>
      expect(backend().executions[0].annotation?.tags.map((t) => t.name)).toEqual(['flaky']),
    );
  });

  it('is read-only for a viewer', async () => {
    signedIn();
    const [run] = await seedRuns(1);
    const tagId = await makeTag('billing');
    await annotate(run.id, { tags: [tagId], vote: 'down' });
    backend().memberships[0].role = 'viewer';
    renderApp(`/executions/${run.id}`);
    const panel = await screen.findByRole('region', { name: 'Execution annotation' }, LONG);
    expect(await within(panel).findByText('billing')).toBeTruthy();
    expect((within(panel).getByRole('button', { name: 'Bad run' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(panel).queryByRole('button', { name: /Edit annotation tags/ })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Remove tag billing' })).toBeNull();
  });
});

describe('executions list', () => {
  it('Filtering by tag finds the run', async () => {
    const user = userEvent.setup();
    signedIn();
    const [newer, older] = await seedRuns(2);
    const tagId = await makeTag('billing');
    await makeTag('ops');
    await annotate(older.id, { tags: [tagId], vote: 'up' });
    renderApp('/executions');
    await screen.findByRole('table', {}, LONG);
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Runner' })).toHaveLength(2));
    expect(screen.getByRole('img', { name: 'Rated good' })).toBeTruthy();
    expect(within(screen.getByRole('table')).getByText('billing')).toBeTruthy();

    await user.selectOptions(await screen.findByLabelText('Filter by tag'), tagId);
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Runner' })).toHaveLength(1));
    expect(
      backend().requests.some((r) => r.path === '/executions' && r.query?.annotationTags === tagId),
    ).toBe(true);
    expect(newer.annotation).toBeNull();

    // the chip removes the filter again
    await user.click(screen.getByRole('button', { name: 'Remove tag billing' }));
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Runner' })).toHaveLength(2));
  });

  it('filters by rating', async () => {
    const user = userEvent.setup();
    signedIn();
    const [, older] = await seedRuns(2);
    await annotate(older.id, { vote: 'down' });
    renderApp('/executions');
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Runner' })).toHaveLength(2), LONG);
    await user.selectOptions(screen.getByLabelText('Filter by rating'), 'down');
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Runner' })).toHaveLength(1));
    await user.selectOptions(screen.getByLabelText('Filter by rating'), 'up');
    await waitFor(() => expect(screen.queryAllByRole('link', { name: 'Runner' })).toHaveLength(0));
  });

  it('stops offering tags once the filter holds the most the server takes', async () => {
    const user = userEvent.setup();
    signedIn();
    await seedRuns(1);
    const ids: string[] = [];
    for (let i = 0; i < MAX_ANNOTATION_FILTER_TAGS + 1; i++) ids.push(await makeTag(`tag-${i}`));
    renderApp('/executions');
    await screen.findByRole('table', {}, LONG);
    for (let i = 0; i < MAX_ANNOTATION_FILTER_TAGS; i++) {
      await user.selectOptions(await screen.findByLabelText('Filter by tag'), ids[i] as string);
      await screen.findByRole('button', { name: `Remove tag tag-${i}` });
    }
    const select = screen.getByLabelText('Filter by tag') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.title).toBe(`The filter takes at most ${MAX_ANNOTATION_FILTER_TAGS} tags`);
    // the last request carried exactly 20 ids: never the 400 above the server's limit
    const sent = backend().requests.filter((r) => r.path === '/executions' && r.query?.annotationTags);
    const last = String(sent[sent.length - 1]?.query?.annotationTags).split(',');
    expect(last).toHaveLength(MAX_ANNOTATION_FILTER_TAGS);
    await user.click(screen.getByRole('button', { name: 'Remove tag tag-0' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Filter by tag') as HTMLSelectElement).disabled).toBe(false),
    );
  }, 120_000);
});
