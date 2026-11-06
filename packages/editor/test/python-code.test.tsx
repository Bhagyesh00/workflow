import { EditorView } from '@codemirror/view';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeEditor, type CodeLanguage, fieldDropText } from '../src/components/code/CodeEditor';
import { FIELD_DRAG_TYPE } from '../src/components/parameters/context';
import { demoNodeTypes } from '../src/demo/fixtures';
import { applyCodeDefaults, CODE_DEFAULTS } from '../src/lib/code-defaults';
import { signedIn } from './backend';
import { renderParameters } from './utils';

const ALL = 'runOnceForAllItems';
const EACH = 'runOnceForEachItem';
const { jsCode, pythonCode } = CODE_DEFAULTS;

describe('applyCodeDefaults', () => {
  it('leaves other nodes alone', () => {
    const next = { language: 'pythonNative' };
    expect(applyCodeDefaults('core.set', { language: 'javaScript' }, next)).toBe(next);
  });

  it('changes nothing when neither language nor mode changed', () => {
    const next = { language: 'pythonNative', mode: ALL, pythonCode: pythonCode[EACH] };
    expect(applyCodeDefaults('core.code', { ...next }, next)).toBe(next);
    const alias = { language: 'pythonNative', mode: ALL };
    expect(applyCodeDefaults('core.code', { language: 'python', mode: ALL }, alias)).toBe(alias);
  });

  it('fills the Python default when the language turns to Python, and keeps the JavaScript', () => {
    const prev = { language: 'javaScript', mode: ALL, jsCode: 'return []' };
    expect(applyCodeDefaults('core.code', prev, { ...prev, language: 'pythonNative' })).toEqual({
      language: 'pythonNative',
      mode: ALL,
      jsCode: 'return []',
      pythonCode: pythonCode[ALL],
    });
  });

  it('fills the JavaScript default when the language turns back', () => {
    const prev = { language: 'pythonNative', mode: EACH, pythonCode: 'x = 1' };
    expect(applyCodeDefaults('core.code', prev, { ...prev, language: 'javaScript' })).toEqual({
      language: 'javaScript',
      mode: EACH,
      pythonCode: 'x = 1',
      jsCode: jsCode[EACH],
    });
  });

  it('swaps untouched default code when the mode changes, in both languages', () => {
    const python = { language: 'pythonNative', mode: ALL, pythonCode: pythonCode[ALL] };
    expect(applyCodeDefaults('core.code', python, { ...python, mode: EACH }).pythonCode).toBe(
      pythonCode[EACH],
    );
    const js = { mode: EACH, jsCode: jsCode[EACH] };
    expect(applyCodeDefaults('core.code', js, { ...js, mode: ALL }).jsCode).toBe(jsCode[ALL]);
  });

  it('keeps edited code', () => {
    const python = { language: 'pythonNative', mode: ALL, pythonCode: 'return _items' };
    const next = { ...python, mode: EACH };
    expect(applyCodeDefaults('core.code', python, next)).toBe(next);
    const toPython = { language: 'pythonNative', mode: ALL, pythonCode: 'mine' };
    expect(applyCodeDefaults('core.code', { language: 'javaScript', mode: ALL }, toPython)).toBe(toPython);
  });

  it('an empty field counts as untouched', () => {
    const prev = { language: 'pythonNative', mode: ALL, pythonCode: '' };
    expect(applyCodeDefaults('core.code', prev, { ...prev, mode: EACH }).pythonCode).toBe(pythonCode[EACH]);
  });
});

describe('the Code node form', () => {
  beforeEach(() => signedIn());

  it('switching to Python shows the Python editor and writes its default', async () => {
    const code = demoNodeTypes.find((d) => d.name === 'core.code');
    if (!code) throw new Error('no demo Code node');
    const { node } = renderParameters(code, { parameters: { language: 'javaScript', mode: ALL } });
    expect(document.querySelector('[data-testid="code-editor-javascript"]')).toBeTruthy();
    const select = screen.getByLabelText('Language');
    fireEvent.change(select, { target: { value: '1' } });
    await waitFor(() => expect(node.current.parameters.pythonCode).toBe(pythonCode[ALL]));
    expect(node.current.parameters.language).toBe('pythonNative');
    await waitFor(() =>
      expect(document.querySelector('[data-testid="code-editor-python"]')?.textContent).toContain('my_new_field'),
    );
  });
});

function Editor({ language, initial, onValue }: { language: CodeLanguage; initial: string; onValue(v: string): void }) {
  const [value, setValue] = useState(initial);
  return (
    <CodeEditor
      language={language}
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue(next);
      }}
      ariaLabel="Code"
    />
  );
}

describe('Python in the code editor', () => {
  it('highlights Python keywords and strings as tokens', async () => {
    render(<CodeEditor language="python" value={'def f():\n    return "x"'} ariaLabel="Code" />);
    const host = screen.getByTestId('code-editor-python');
    await waitFor(() => {
      const tokens = [...host.querySelectorAll('.cm-line span')].map((el) => el.textContent);
      expect(tokens).toContain('def');
      expect(tokens).toContain('return');
      expect(tokens).toContain('"x"');
    });
  });

  it('JavaScript still has its own highlighting', async () => {
    render(<CodeEditor language="javascript" value={'const a = 1'} ariaLabel="Code" />);
    const host = screen.getByTestId('code-editor-javascript');
    await waitFor(() => {
      const tokens = [...host.querySelectorAll('.cm-line span')].map((el) => el.textContent);
      expect(tokens).toContain('const');
    });
  });
});

describe('fieldDropText', () => {
  it.each([
    ['{{ $json.name }}', 'javascript', '$json.name'],
    ['{{ $json.a.b[0] }}', 'javascript', '$json.a.b[0]'],
    ['{{ $json["first name"] }}', 'javascript', '$json["first name"]'],
    ["{{ $('Set').item.json.a }}", 'javascript', "$('Set').item.json.a"],
    ['{{ $json.name }}', 'python', '_item["json"]["name"]'],
    ['{{ $json.a.b[0] }}', 'python', '_item["json"]["a"]["b"][0]'],
    ['{{ $json["first name"].x }}', 'python', '_item["json"]["first name"]["x"]'],
    ['{{ $json["a.b"] }}', 'python', '_item["json"]["a.b"]'],
    ["{{ $('My \\'Set').item.json.a }}", 'python', '_item["json"]["a"]'],
    ['{{ $json }}', 'python', '_item["json"]'],
    ['{{ $now }}', 'python', '$now'],
  ] as Array<[string, CodeLanguage, string]>)('%s in %s', (dropped, language, text) => {
    expect(fieldDropText(dropped, language)).toBe(text);
  });
});

describe('dropping a field into the code editor', () => {
  afterEach(() => vi.restoreAllMocks());

  function drop(target: Element, type: string, value: string) {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: [type], getData: (t: string) => (t === type ? value : '') },
    });
    Object.assign(event, { clientX: 1, clientY: 1 });
    target.dispatchEvent(event);
    return event;
  }

  it.each([
    ['python', 'ab', '_item["json"]["x"]', 'a_item["json"]["x"]b'],
    ['javascript', 'ab', '$json.x', 'a$json.xb'],
  ] as Array<[CodeLanguage, string, string, string]>)(
    'inserts at the drop point in %s and hides the drop from the form',
    async (language, initial, _text, expected) => {
      vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(1);
      const onValue = vi.fn();
      const formDrop = vi.fn();
      render(
        // biome-ignore lint/a11y/noStaticElementInteractions: stands in for the form around the editor
        <div onDrop={formDrop}>
          <Editor language={language} initial={initial} onValue={onValue} />
        </div>,
      );
      const content = screen.getByTestId(`code-editor-${language}`).querySelector('.cm-content');
      if (!content) throw new Error('no editor');
      const event = drop(content, FIELD_DRAG_TYPE, '{{ $json.x }}');
      await waitFor(() => expect(onValue).toHaveBeenCalledWith(expected));
      expect(event.defaultPrevented).toBe(true);
      expect(formDrop).not.toHaveBeenCalled();
    },
  );

  it('leaves other drops and read-only editors alone', async () => {
    const spy = vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(0);
    const onValue = vi.fn();
    const { unmount } = render(<Editor language="python" initial="ab" onValue={onValue} />);
    const content = screen.getByTestId('code-editor-python').querySelector('.cm-content');
    if (!content) throw new Error('no editor');
    drop(content, 'text/x-other', 'nope');
    expect(onValue).not.toHaveBeenCalled();
    unmount();

    spy.mockClear();
    render(<CodeEditor language="python" value="ab" readOnly onChange={onValue} ariaLabel="Code" />);
    const locked = screen.getByTestId('code-editor-python').querySelector('.cm-content');
    if (!locked) throw new Error('no editor');
    drop(locked, FIELD_DRAG_TYPE, '{{ $json.x }}');
    expect(onValue).not.toHaveBeenCalled();
  });
});
