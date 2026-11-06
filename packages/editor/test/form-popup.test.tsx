/** P4-02: the form popup opens once per waiting Form task; the demo's run stops there with the metadata. */
import type { TaskData, WorkflowNode } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simulateExecution } from '../src/demo/simulator';
import { maybeOpenFormPopup, openTestForm, resetFormPopup } from '../src/features/editor/form-popup';

const URL_A = 'http://localhost:5678/form-waiting/e1/sig';

const task = (overrides: Partial<TaskData> = {}): TaskData => ({
  startTime: 1,
  executionTime: 1,
  executionStatus: 'waiting',
  source: [],
  metadata: { resumeFormUrl: URL_A },
  ...overrides,
});

interface FakeWindow {
  closed: boolean;
  opener: unknown;
}

let opened: FakeWindow[];
let open: ReturnType<typeof vi.fn>;

beforeEach(() => {
  opened = [];
  open = vi.fn(() => {
    const popup = { closed: false, opener: window };
    opened.push(popup);
    return popup as unknown as Window;
  });
  vi.stubGlobal('open', open);
  window.open = open as never;
  resetFormPopup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('maybeOpenFormPopup', () => {
  it('opens the page of a waiting Form task once', () => {
    const waiting = task();
    maybeOpenFormPopup(waiting);
    maybeOpenFormPopup(waiting);
    maybeOpenFormPopup({ ...waiting });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toBe(URL_A);
  });

  it('cuts the link back to the editor', () => {
    maybeOpenFormPopup(task());
    expect(opened[0].opener).toBeNull();
  });

  it.each([
    ['a task that is not waiting', task({ executionStatus: 'success' })],
    ['a waiting task with no form', task({ metadata: undefined })],
    ['a form URL that is no string', task({ metadata: { resumeFormUrl: 5 } })],
    ['a URL that is not http or https', task({ metadata: { resumeFormUrl: 'javascript:alert(1)' } })],
  ])('opens nothing for %s', (_name, data) => {
    maybeOpenFormPopup(data);
    expect(open).not.toHaveBeenCalled();
  });

  it('a popup that is still open goes on by itself', () => {
    openTestForm('http://localhost:5678/form-test/acme/signup');
    expect(open).toHaveBeenCalledTimes(1);
    maybeOpenFormPopup(task());
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('after the popup is closed, the next waiting task opens one', () => {
    maybeOpenFormPopup(task());
    opened[0].closed = true;
    maybeOpenFormPopup(task({ startTime: 2 }));
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('a popup that already shows a sandboxed page does not fail', () => {
    const sandboxed = {
      closed: false,
      get opener() {
        return null;
      },
      set opener(_value: unknown) {
        throw new DOMException('Blocked', 'SecurityError');
      },
    };
    open.mockReturnValue(sandboxed);
    expect(() => openTestForm('http://localhost:5678/form-test/acme/signup')).not.toThrow();
  });

  it('a blocked popup does not fail', () => {
    open.mockReturnValue(null);
    expect(() => maybeOpenFormPopup(task())).not.toThrow();
  });
});

describe('openTestForm', () => {
  it('opens the URL each time it is asked, in the one popup', () => {
    const url = 'http://localhost:5678/form-test/acme/signup';
    openTestForm(url);
    openTestForm(url);
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[0][1]).toBe(open.mock.calls[1][1]);
  });

  it('opens nothing for a URL that is not http or https', () => {
    openTestForm('javascript:alert(1)');
    expect(open).not.toHaveBeenCalled();
  });
});

describe('the demo run', () => {
  const nodeOf = (name: string, type: string, parameters: WorkflowNode['parameters'] = {}): WorkflowNode => ({
    id: name,
    name,
    type,
    typeVersion: 1,
    position: [0, 0],
    parameters,
  });
  const run = (nodes: WorkflowNode[], chainNames: string[]) => {
    const connections: Record<string, unknown> = {};
    for (let i = 0; i < chainNames.length - 1; i++) {
      connections[chainNames[i]] = { main: [[{ node: chainNames[i + 1], type: 'main', index: 0 }]] };
    }
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = simulateExecution({
      executionId: 'demo-1',
      workflow: { id: 'w1', name: 'demo', nodes, connections } as never,
      mode: 'manual',
      variables: {},
      emit: (event) => events.push(event as never),
      stepDelayMs: 0,
    });
    return { result, events };
  };

  it('a Form node stops the run with a waiting task that carries the form URL', async () => {
    const { result, events } = run(
      [nodeOf('Start', 'core.formTrigger'), nodeOf('Page', 'core.form'), nodeOf('Never', 'core.set')],
      ['Start', 'Page', 'Never'],
    );
    const done = await result;
    expect(done.status).toBe('waiting');
    expect(done.lastNodeExecuted).toBe('Page');
    const page = done.runData.Page[0];
    expect(page.executionStatus).toBe('waiting');
    expect(String(page.metadata?.resumeFormUrl)).toContain('/form-waiting/demo-1/');
    expect(done.runData.Never).toBeUndefined();
    expect(done.runData.Start[0].data?.main?.[0]?.[0]?.json).toHaveProperty('formMode', 'test');
    const finished = events.find((e) => e.type === 'executionFinished');
    expect(finished?.data.status).toBe('waiting');
  });

  it('a Wait on a form does the same, other waits go on', async () => {
    const form = await run(
      [nodeOf('Start', 'core.manualTrigger'), nodeOf('Wait', 'core.wait', { resume: 'form' })],
      ['Start', 'Wait'],
    ).result;
    expect(form.status).toBe('waiting');
    expect(form.runData.Wait[0].metadata?.resumeFormUrl).toBeTruthy();

    const timed = await run(
      [nodeOf('Start', 'core.manualTrigger'), nodeOf('Wait', 'core.wait', { resume: 'timeInterval' })],
      ['Start', 'Wait'],
    ).result;
    expect(timed.status).toBe('success');
  });

  it('the event a waiting Form task sends opens the popup once', async () => {
    const { result, events } = run(
      [nodeOf('Start', 'core.formTrigger'), nodeOf('Page', 'core.form')],
      ['Start', 'Page'],
    );
    await result;
    for (const event of events) {
      if (event.type === 'nodeExecuteAfter') maybeOpenFormPopup(event.data.taskData as TaskData);
    }
    expect(open).toHaveBeenCalledTimes(1);
  });
});
