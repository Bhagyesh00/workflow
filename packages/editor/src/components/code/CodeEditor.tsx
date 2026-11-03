/**
 * CodeMirror 6 wrapper used for JSON, JavaScript (Code node) and `{{ }}` expressions.
 * The view is created once per language; external value changes are patched into the document.
 */
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionSource,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  keymap,
  lineNumbers,
  MatchDecorator,
  placeholder as placeholderExt,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef } from 'react';
import { cx } from '../ui/cx';
import { type CompletionData, completeExpression, enclosingExpressionStart } from './completions';

export type CodeLanguage = 'javascript' | 'json' | 'expression' | 'text';

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--wf-cm-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--wf-cm-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--wf-cm-number)' },
  { tag: [tags.propertyName], color: 'var(--wf-cm-property)' },
  { tag: [tags.variableName], color: 'var(--wf-ink)' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: 'var(--wf-cm-function)',
  },
  { tag: tags.comment, color: 'var(--wf-ink-3)', fontStyle: 'italic' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: 'var(--wf-ink-2)' },
]);

const theme = EditorView.theme({
  '&': {
    fontSize: '12.5px',
    backgroundColor: 'transparent',
    color: 'var(--wf-ink)',
    '--wf-cm-keyword': 'color-mix(in oklab, var(--wf-brand) 85%, var(--wf-ink))',
    '--wf-cm-string': 'var(--wf-ok)',
    '--wf-cm-number': 'var(--wf-warn)',
    '--wf-cm-property': 'var(--wf-pin)',
    '--wf-cm-function': 'color-mix(in oklab, var(--wf-brand) 70%, var(--wf-ink))',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--wf-brand)', padding: '6px 0' },
  '.cm-line': { padding: '0 10px' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--wf-ink-3)',
    border: 'none',
    borderRight: '1px solid var(--wf-line)',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'color-mix(in oklab, var(--wf-brand) 22%, transparent) !important',
  },
  '.cm-cursor': { borderLeftColor: 'var(--wf-brand)' },
  '.cm-placeholder': { color: 'var(--wf-ink-3)' },
  '.cm-wf-resolvable': {
    backgroundColor: 'color-mix(in oklab, var(--wf-brand) 12%, transparent)',
    borderRadius: '3px',
    color: 'color-mix(in oklab, var(--wf-brand) 80%, var(--wf-ink))',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--wf-surface)',
    border: '1px solid var(--wf-line)',
    borderRadius: '8px',
    boxShadow: 'var(--wf-shadow-lift)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete ul li': { padding: '3px 8px', fontFamily: 'var(--font-mono)', fontSize: '12px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--wf-brand)',
    color: 'var(--wf-on-brand)',
  },
  '.cm-completionDetail': { marginLeft: '8px', fontStyle: 'normal', opacity: '0.7' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--wf-err)' },
});

const resolvableMatcher = new MatchDecorator({
  regexp: /\{\{[\s\S]*?\}\}/g,
  decoration: Decoration.mark({ class: 'cm-wf-resolvable' }),
});

/** Highlights `{{ ... }}` segments in expression templates. */
export const resolvableHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = resolvableMatcher.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = resolvableMatcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

function toCompletionSource(
  getData: () => CompletionData | undefined,
  insideBracesOnly: boolean,
): CompletionSource {
  return (context: CompletionContext) => {
    const data = getData();
    if (!data) return null;
    const doc = context.state.doc.toString();
    let start = 0;
    if (insideBracesOnly) {
      start = enclosingExpressionStart(doc, context.pos);
      if (start === -1) return null;
    } else {
      start = context.state.doc.lineAt(context.pos).from;
    }
    const before = doc.slice(start, context.pos);
    // the whole document is code only in the Code node editor; `{{ }}` fields are expressions
    const result = completeExpression(before, data, { codeNode: !insideBracesOnly });
    if (!result) return null;
    if (
      !context.explicit &&
      result.from === before.length &&
      !before.endsWith('.') &&
      !before.endsWith("'")
    ) {
      return null;
    }
    const options: Completion[] = result.options.map((o) => ({
      label: o.label,
      apply: o.apply ?? o.label,
      detail: o.detail,
      type: o.type,
    }));
    return { from: start + result.from, options, validFor: /^[\w$]*$/ };
  };
}

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language: CodeLanguage;
  readOnly?: boolean;
  placeholder?: string;
  /** rows of minimum height */
  minRows?: number;
  maxHeight?: number;
  lineNumbers?: boolean;
  completions?: () => CompletionData | undefined;
  ariaLabel: string;
  className?: string;
  onBlur?: () => void;
  autoFocus?: boolean;
}

export function CodeEditor({
  value,
  onChange,
  language,
  readOnly,
  placeholder,
  minRows = 1,
  maxHeight,
  lineNumbers: showLineNumbers,
  completions,
  ariaLabel,
  className,
  onBlur,
  autoFocus,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const completionsRef = useRef(completions);
  const onBlurRef = useRef(onBlur);
  onChangeRef.current = onChange;
  completionsRef.current = completions;
  onBlurRef.current = onBlur;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the view is rebuilt only for structural options; value is synced below
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const extensions: Extension[] = [
      history(),
      drawSelection(),
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      syntaxHighlighting(highlight),
      theme,
      EditorView.lineWrapping,
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
      EditorState.readOnly.of(Boolean(readOnly)),
      EditorView.editable.of(!readOnly),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
        if (update.focusChanged && !update.view.hasFocus) onBlurRef.current?.();
      }),
    ];
    if (placeholder) extensions.push(placeholderExt(placeholder));
    if (showLineNumbers) extensions.push(lineNumbers());
    if (language === 'json') {
      extensions.push(json());
    } else if (language === 'javascript') {
      extensions.push(
        javascript(),
        javascriptLanguage.data.of({
          autocomplete: toCompletionSource(() => completionsRef.current?.(), false),
        }),
        autocompletion({ activateOnTyping: true }),
      );
    } else if (language === 'expression') {
      extensions.push(
        resolvableHighlighter,
        autocompletion({
          override: [toCompletionSource(() => completionsRef.current?.(), true)],
          activateOnTyping: true,
        }),
      );
    }
    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: value, extensions }),
    });
    viewRef.current = view;
    if (autoFocus) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [language, readOnly, placeholder, showLineNumbers, ariaLabel]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return (
    <div
      ref={hostRef}
      className={cx('wf-scroll overflow-auto', className)}
      style={{ minHeight: `${minRows * 20 + 14}px`, maxHeight }}
      data-testid={`code-editor-${language}`}
    />
  );
}

/** Insert text at the cursor of the editor rendered inside `host`, if any. */
export function insertIntoEditor(host: HTMLElement | null, text: string): boolean {
  const content = host?.querySelector('.cm-content') as
    | (HTMLElement & { cmView?: { view: EditorView } })
    | null;
  const view = content ? EditorView.findFromDOM(content) : null;
  if (!view) return false;
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  view.focus();
  return true;
}
