/**
 * `$`-variable completion shared by the expression editor and the Code node editor.
 * `completeExpression` is pure (text before the cursor in, suggestions out) so it is unit tested.
 */

export interface CompletionData {
  /** keys at a path of the active node's input `$json` */
  inputFields(path: Array<string | number>): string[];
  /** node names usable in `$('...')` */
  nodeNames: string[];
  /** keys at a path of `$('Node').item.json` */
  nodeFields(node: string, path: Array<string | number>): string[];
  variables: string[];
  /** secret names by connection key (credential forms only; `$secrets` is undefined in nodes and Code) */
  secrets?: Record<string, string[]>;
}

export interface Suggestion {
  label: string;
  /** text inserted (defaults to label) */
  apply?: string;
  detail?: string;
  type: 'variable' | 'property' | 'method' | 'function' | 'keyword';
}

export interface CompletionResult {
  /** offset (from the start of `before`) where the replaced word starts */
  from: number;
  options: Suggestion[];
}

/** only in the Code node editor (as in n8n): expressions cannot read or write static data */
const CODE_ROOTS: Suggestion[] = [
  {
    label: '$getWorkflowStaticData',
    apply: "$getWorkflowStaticData('",
    type: 'function',
    detail: "Data kept between runs ('global' or 'node')",
  },
];

const ROOTS: Suggestion[] = [
  { label: '$json', type: 'variable', detail: 'Current item data' },
  { label: '$input', type: 'variable', detail: 'Input items of this node' },
  { label: "$('", apply: "$('", type: 'function', detail: 'Data of another node' },
  { label: '$binary', type: 'variable', detail: 'Binary data of the current item' },
  { label: '$now', type: 'variable', detail: 'Current date and time (DateTime)' },
  { label: '$today', type: 'variable', detail: 'Start of today (DateTime)' },
  { label: '$vars', type: 'variable', detail: 'Workspace variables' },
  { label: '$execution', type: 'variable', detail: 'Execution id, mode, custom data' },
  { label: '$workflow', type: 'variable', detail: 'Workflow id, name, active' },
  { label: '$prevNode', type: 'variable', detail: 'The node the input came from' },
  { label: '$parameter', type: 'variable', detail: 'Parameters of this node' },
  { label: '$runIndex', type: 'variable', detail: 'How often this node ran' },
  { label: '$itemIndex', type: 'variable', detail: 'Index of the current item' },
  { label: '$if', apply: '$if(', type: 'function', detail: '$if(condition, then, else)' },
  { label: '$ifEmpty', apply: '$ifEmpty(', type: 'function', detail: '$ifEmpty(value, fallback)' },
  { label: '$jmespath', apply: '$jmespath(', type: 'function', detail: 'Query JSON with JMESPath' },
  { label: '$min', apply: '$min(', type: 'function' },
  { label: '$max', apply: '$max(', type: 'function' },
  { label: '$items', apply: '$items(', type: 'function', detail: 'Items of a node (legacy)' },
  { label: 'DateTime', type: 'variable', detail: 'Luxon DateTime' },
  { label: 'Math', type: 'variable' },
  { label: 'JSON', type: 'variable' },
];

/** offered only when the form can read secrets: a credential field */
const SECRETS_ROOT: Suggestion = {
  label: '$secrets',
  type: 'variable',
  detail: 'Secrets of your connections',
};

const INPUT_MEMBERS: Suggestion[] = [
  { label: 'item', type: 'property', detail: 'Current input item' },
  { label: 'all()', type: 'method', detail: 'All input items' },
  { label: 'first()', type: 'method' },
  { label: 'last()', type: 'method' },
  { label: 'params', type: 'property' },
];

const NODE_MEMBERS: Suggestion[] = [
  { label: 'item', type: 'property', detail: 'Item paired with the current one' },
  { label: 'first()', type: 'method' },
  { label: 'last()', type: 'method' },
  { label: 'all()', type: 'method' },
  { label: 'itemMatching(', type: 'method' },
  { label: 'isExecuted', type: 'property' },
  { label: 'params', type: 'property' },
];

const ITEM_MEMBERS: Suggestion[] = [
  { label: 'json', type: 'property' },
  { label: 'binary', type: 'property' },
];

const EXECUTION_MEMBERS: Suggestion[] = [
  { label: 'id', type: 'property' },
  { label: 'mode', type: 'property' },
  { label: 'resumeUrl', type: 'property' },
  { label: 'resumeFormUrl', type: 'property' },
  { label: 'customData', type: 'property' },
];

const WORKFLOW_MEMBERS: Suggestion[] = [
  { label: 'id', type: 'property' },
  { label: 'name', type: 'property' },
  { label: 'active', type: 'property' },
];

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** `.a["b c"][0]` -> ['a', 'b c', 0] (lenient; stops at anything else) */
export function parseAccessPath(text: string): Array<string | number> | null {
  const path: Array<string | number> = [];
  const re = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\[\s*(['"])((?:\\.|(?!\3).)*)\3\s*\]/y;
  let index = 0;
  while (index < text.length) {
    re.lastIndex = index;
    const m = re.exec(text);
    if (!m) return null;
    if (m[1] !== undefined) path.push(m[1]);
    else if (m[2] !== undefined) path.push(Number(m[2]));
    else path.push(m[4]);
    index = re.lastIndex;
  }
  return path;
}

function fields(keys: string[]): Suggestion[] {
  return keys.map((key) =>
    IDENT.test(key)
      ? { label: key, type: 'property' as const }
      : { label: key, apply: `["${key.replace(/"/g, '\\"')}"]`, type: 'property' as const },
  );
}

function filter(options: Suggestion[], prefix: string): Suggestion[] {
  if (!prefix) return options;
  const p = prefix.toLowerCase();
  return options.filter((o) => o.label.toLowerCase().startsWith(p));
}

/**
 * Suggestions for the code just before the cursor (`before` is the text inside `{{ }}` or in a
 * code editor up to the cursor).
 */
export function completeExpression(
  before: string,
  data: CompletionData,
  options: { codeNode?: boolean } = {},
): CompletionResult | null {
  // $('Partial  -> node names
  const nodeName = before.match(/\$\(\s*(['"])([^'"]*)$/);
  if (nodeName) {
    const quote = nodeName[1];
    const typed = nodeName[2];
    return {
      from: before.length - typed.length,
      options: filter(
        data.nodeNames.map((n) => ({ label: n, apply: `${n}${quote})`, type: 'variable' as const })),
        typed,
      ),
    };
  }

  // member access chain ending in `.partial`
  const member = before.match(
    /(\$[A-Za-z_]*(?:\(\s*(['"])(?:\\.|(?!\2).)*\2\s*\))?)((?:\.[A-Za-z_$][\w$]*(?:\(\))?|\[\d+\]|\[\s*(['"])(?:\\.|(?!\4).)*\4\s*\])*)\.([A-Za-z_$][\w$]*)?$/,
  );
  if (member) {
    const root = member[1];
    const chain = member[3] ?? '';
    const typed = member[5] ?? '';
    const from = before.length - typed.length;
    const done = (options: Suggestion[]): CompletionResult | null =>
      options.length ? { from, options: filter(options, typed) } : null;

    if (root === '$json') {
      const path = parseAccessPath(chain);
      return path ? done(fields(data.inputFields(path))) : null;
    }
    if (root === '$input') {
      if (!chain) return done(INPUT_MEMBERS);
      if (chain === '.item' || chain === '.first()' || chain === '.last()') return done(ITEM_MEMBERS);
      const json = chain.match(/^\.(?:item|first\(\)|last\(\))\.json(.*)$/);
      if (json) {
        const path = parseAccessPath(json[1]);
        return path ? done(fields(data.inputFields(path))) : null;
      }
      return null;
    }
    const nodeRef = root.match(/^\$\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)$/);
    if (nodeRef) {
      const name = nodeRef[2].replace(/\\(.)/g, '$1');
      if (!chain) return done(NODE_MEMBERS);
      if (/^\.(item|first\(\)|last\(\))$/.test(chain)) return done(ITEM_MEMBERS);
      const json = chain.match(/^\.(?:item|first\(\)|last\(\))\.json(.*)$/);
      if (json) {
        const path = parseAccessPath(json[1]);
        return path ? done(fields(data.nodeFields(name, path))) : null;
      }
      return null;
    }
    if (root === '$vars' && !chain) return done(fields(data.variables));
    if (root === '$secrets' && data.secrets) {
      const path = parseAccessPath(chain);
      if (!path || path.length > 1) return null;
      if (path.length === 0) return done(fields(Object.keys(data.secrets)));
      return done(fields(data.secrets[String(path[0])] ?? []));
    }
    if (root === '$execution' && !chain) return done(EXECUTION_MEMBERS);
    if (root === '$workflow' && !chain) return done(WORKFLOW_MEMBERS);
    if (root === '$prevNode' && !chain) {
      return done([
        { label: 'name', type: 'property' },
        { label: 'outputIndex', type: 'property' },
        { label: 'runIndex', type: 'property' },
      ]);
    }
    return null;
  }

  // a bare word: root variables
  const word = before.match(/(\$?[A-Za-z_][\w$]*|\$)$/);
  if (word) {
    const typed = word[1];
    const all = options.codeNode ? [...ROOTS, ...CODE_ROOTS] : ROOTS;
    const roots = filter(data.secrets ? [...all, SECRETS_ROOT] : all, typed);
    return roots.length ? { from: before.length - typed.length, options: roots } : null;
  }
  return null;
}

/** Position of the `{{` that encloses `pos` in `text`, or -1 when `pos` is outside any `{{ }}`. */
export function enclosingExpressionStart(text: string, pos: number): number {
  const open = text.lastIndexOf('{{', pos - 1);
  if (open === -1 || open + 2 > pos) return -1;
  const close = text.indexOf('}}', open + 2);
  if (close !== -1 && close < pos) return -1;
  return open + 2;
}
