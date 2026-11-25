import { LineMap, type Token, tokenize } from './rustLexer';

export interface Position {
  line: number;
  character: number;
}

/** Something Python can see that a Rust item defines. */
export interface PyItem {
  kind: 'class' | 'function' | 'method' | 'property' | 'constructor' | 'variant';
  /** The Rust identifier: the struct, enum, fn, or field name. */
  rustName: string;
  /** The name Python uses, after `name = "…"`, getter and setter rules. */
  pyName: string;
  /** For members, the Rust type whose `#[pymethods]`, fields or variants hold it. */
  owner?: string;
  /** `#[pyclass(module = "…")]`, when given. */
  pyModule?: string;
  file: string;
  pos: Position;
}

/** A name a `#[pymodule]` puts into the Python module. */
export interface ModuleExport {
  /** The Rust path as written, without the final name, e.g. `crate::db`. */
  path: string[];
  rustName: string;
  /** Set only when the export picks its own Python name (`set_item`). */
  pyName?: string;
  pos: Position;
}

export interface PyModuleDef {
  rustName: string;
  pyName: string;
  file: string;
  pos: Position;
  exports: ModuleExport[];
}

/** A `const NAME: &str = "…";`, which is how Rust tends to name a Python module. */
export interface StrConst {
  name: string;
  value: string;
  pos: Position;
}

export interface RustFileIndex {
  file: string;
  items: PyItem[];
  modules: PyModuleDef[];
  consts: StrConst[];
  /** String literals passed straight to an `import(…)` call. */
  importLiterals: string[];
}

interface Attr {
  name: string;
  args: Token[];
}

type Context =
  | { kind: 'methods'; owner: string; depth: number }
  | { kind: 'struct'; owner: string; depth: number; allFields: boolean }
  | { kind: 'enum'; owner: string; depth: number }
  | { kind: 'module'; module: PyModuleDef; depth: number };

/** Attribute names whose items Python can see, matched on the last path segment. */
const PY_ITEM_ATTRS = new Set(['pyclass', 'pyfunction', 'pymodule', 'pymethods']);

export function indexRustSource(file: string, src: string): RustFileIndex {
  const out: RustFileIndex = { file, items: [], modules: [], consts: [], importLiterals: [] };
  // Most files never touch PyO3 or Python; only their string constants count.
  const pyo3 = PY_ITEM_ATTRS_RE.test(src);
  if (!pyo3 && !src.includes('import')) return out;
  const toks = tokenize(src);
  const lines = new LineMap(src);
  const at = (t: Token): Position => lines.position(t.start);
  const is = (i: number, text: string): boolean => toks[i]?.text === text && toks[i].kind !== 'string';

  let attrs: Attr[] = [];
  const contexts: Context[] = [];
  let pending: Context | undefined;
  let depth = 0;
  const top = (): Context | undefined => contexts[contexts.length - 1];
  const enclosingModule = (): PyModuleDef | undefined => {
    for (let k = contexts.length - 1; k >= 0; k--) {
      const c = contexts[k];
      if (c.kind === 'module') return c.module;
    }
    return undefined;
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'punct') {
      if (t.text === '#' && (is(i + 1, '[') || (is(i + 1, '!') && is(i + 2, '[')))) {
        const inner = is(i + 1, '!');
        const open = inner ? i + 2 : i + 1;
        const close = matching(toks, open, '[', ']');
        if (!inner) attrs.push(parseAttr(toks.slice(open + 1, close)));
        i = close;
        continue;
      }
      if (t.text === '{') {
        depth++;
        if (pending) {
          pending.depth = depth;
          contexts.push(pending);
          pending = undefined;
        }
        attrs = [];
      } else if (t.text === '}') {
        while (contexts.length > 0 && top()!.depth === depth) contexts.pop();
        depth--;
        attrs = [];
      } else if (t.text === ';') {
        pending = undefined;
        attrs = [];
      } else if (t.text === ',') {
        attrs = [];
      }
      continue;
    }
    if (t.kind === 'string') {
      continue;
    }
    if (t.kind !== 'ident') continue;

    switch (t.text) {
      case 'pub':
        if (is(i + 1, '(')) i = matching(toks, i + 1, '(', ')');
        continue;
      case 'async':
      case 'unsafe':
      case 'extern':
        continue;
      case 'let':
        attrs = [];
        continue;
      case 'const': {
        // `const fn`, a `const { … }` block, or a const generic parameter.
        if (is(i + 1, 'fn') || is(i + 1, '{') || is(i - 1, '<') || is(i - 1, ',')) continue;
        const name = toks[i + 1];
        const eq = findAtLevel(toks, i + 1, '=', ';');
        const value = eq === undefined ? undefined : toks[eq + 1];
        if (name?.kind === 'ident' && value?.kind === 'string' && is(eq! + 2, ';')) {
          out.consts.push({ name: name.text, value: value.text, pos: at(name) });
        }
        attrs = [];
        continue;
      }
      case 'use': {
        const end = findAtLevel(toks, i, ';', undefined) ?? toks.length - 1;
        const module = enclosingModule();
        if (module && has(attrs, 'pymodule_export')) {
          parseUseTree(toks, i + 1, end, [], module.exports, at);
        }
        attrs = [];
        i = end;
        continue;
      }
      case 'fn': {
        const name = toks[i + 1];
        if (name?.kind === 'ident') handleFn(name);
        attrs = [];
        continue;
      }
      case 'struct':
      case 'enum': {
        const name = toks[i + 1];
        if (name?.kind === 'ident' && has(attrs, 'pyclass')) {
          const pyclass = find(attrs, 'pyclass')!;
          const item: PyItem = {
            kind: 'class',
            rustName: name.text,
            pyName: stringArg(pyclass, 'name') ?? name.text,
            pyModule: stringArg(pyclass, 'module'),
            file,
            pos: at(name),
          };
          out.items.push(item);
          enclosingModule()?.exports.push({ path: [], rustName: name.text, pos: at(name) });
          if (t.text === 'struct') {
            const allFields = pyclass.args.some((a) => a.text === 'get_all' || a.text === 'set_all');
            pending = { kind: 'struct', owner: name.text, depth: 0, allFields };
          } else {
            pending = { kind: 'enum', owner: name.text, depth: 0 };
          }
        }
        attrs = [];
        continue;
      }
      case 'impl': {
        if (has(attrs, 'pymethods')) {
          const owner = implOwner(toks, i + 1);
          if (owner) pending = { kind: 'methods', owner, depth: 0 };
        }
        attrs = [];
        continue;
      }
      case 'mod': {
        const name = toks[i + 1];
        if (name?.kind === 'ident' && has(attrs, 'pymodule')) {
          const module = moduleDef(name, find(attrs, 'pymodule')!);
          out.modules.push(module);
          pending = { kind: 'module', module, depth: 0 };
        }
        attrs = [];
        continue;
      }
      case 'import': {
        // `py.import("x")`, `PyModule::import(py, "x")`, `.import(intern!(py, "x"))`.
        if (is(i + 1, '(')) {
          const close = matching(toks, i + 1, '(', ')');
          const lit = toks.slice(i + 2, close).find((k) => k.kind === 'string');
          if (lit) out.importLiterals.push(lit.text);
        }
        continue;
      }
      case 'create_exception': {
        // `create_exception!(module, Name, Base, "doc")`: a class with no item of its own.
        if (is(i + 1, '!') && is(i + 2, '(')) {
          const comma = findAtLevel(toks, i + 2, ',', ')');
          const name = comma === undefined ? undefined : toks[comma + 1];
          if (name?.kind === 'ident') {
            out.items.push({ kind: 'class', rustName: name.text, pyName: name.text, file, pos: at(name) });
          }
        }
        continue;
      }
      case 'wrap_pyfunction': {
        const module = enclosingModule();
        if (module && is(i + 1, '!') && is(i + 2, '(')) {
          const path = pathAt(toks, i + 3);
          if (path.length > 0) {
            module.exports.push({
              path: path.slice(0, -1).map((p) => p.text),
              rustName: path[path.length - 1].text,
              pos: at(path[path.length - 1]),
            });
          }
        }
        continue;
      }
      case 'add_class': {
        const module = enclosingModule();
        if (module && is(i + 1, ':') && is(i + 2, ':') && is(i + 3, '<')) {
          const path = pathAt(toks, i + 4);
          if (path.length > 0) {
            module.exports.push({
              path: path.slice(0, -1).map((p) => p.text),
              rustName: path[path.length - 1].text,
              pos: at(path[path.length - 1]),
            });
          }
        }
        continue;
      }
      case 'set_item': {
        // `module.dict().set_item("Name", py.get_type::<path::Type>())`.
        const module = enclosingModule();
        if (module && is(i + 1, '(') && toks[i + 2]?.kind === 'string') {
          const close = matching(toks, i + 1, '(', ')');
          for (let k = i + 3; k < close; k++) {
            if (toks[k].text === 'get_type' && is(k + 1, ':') && is(k + 2, ':') && is(k + 3, '<')) {
              const path = pathAt(toks, k + 4);
              if (path.length > 0) {
                module.exports.push({
                  path: path.slice(0, -1).map((p) => p.text),
                  rustName: path[path.length - 1].text,
                  pyName: toks[i + 2].text,
                  pos: at(toks[i + 2]),
                });
              }
              break;
            }
          }
        }
        continue;
      }
      default: {
        const ctx = top();
        // A variant of a `#[pyclass]` enum, which Python sees as `Enum.Variant`.
        if (ctx?.kind === 'enum' && ctx.depth === depth && ['{', ',', ']'].includes(toks[i - 1]?.text)) {
          out.items.push({
            kind: 'variant',
            rustName: t.text,
            pyName: stringArg(find(attrs, 'pyo3'), 'name') ?? t.text,
            owner: ctx.owner,
            file,
            pos: at(t),
          });
          attrs = [];
          continue;
        }
        if (ctx?.kind === 'struct' && ctx.depth === depth && is(i + 1, ':') && !is(i + 2, ':')) {
          const pyo3Attr = find(attrs, 'pyo3');
          if (ctx.allFields || pyo3Attr?.args.some((a) => a.text === 'get' || a.text === 'set')) {
            out.items.push({
              kind: 'property',
              rustName: t.text,
              pyName: stringArg(pyo3Attr, 'name') ?? t.text,
              owner: ctx.owner,
              file,
              pos: at(t),
            });
          }
          attrs = [];
        }
        continue;
      }
    }
  }
  return out;

  function handleFn(name: Token): void {
    const ctx = top();
    const rename = stringArg(find(attrs, 'pyo3'), 'name');
    if (ctx?.kind === 'methods' && ctx.depth === depth) {
      out.items.push({ ...methodNames(name.text, rename), rustName: name.text, owner: ctx.owner, file, pos: at(name) });
      return;
    }
    if (has(attrs, 'pymodule')) {
      const module = moduleDef(name, find(attrs, 'pymodule')!);
      out.modules.push(module);
      pending = { kind: 'module', module, depth: 0 };
      return;
    }
    if (has(attrs, 'pyfunction')) {
      out.items.push({
        kind: 'function',
        rustName: name.text,
        pyName: rename ?? stringArg(find(attrs, 'pyfunction'), 'name') ?? name.text,
        file,
        pos: at(name),
      });
      enclosingModule()?.exports.push({ path: [], rustName: name.text, pos: at(name) });
    }
  }

  /** How PyO3 names a fn inside `#[pymethods]`. */
  function methodNames(rustName: string, rename: string | undefined): Pick<PyItem, 'kind' | 'pyName'> {
    if (has(attrs, 'new')) return { kind: 'constructor', pyName: '__new__' };
    const getter = find(attrs, 'getter') ?? find(attrs, 'setter');
    if (getter) {
      const explicit = getter.args.find((a) => a.kind === 'ident' || a.kind === 'string');
      const prefix = getter.name === 'getter' ? 'get_' : 'set_';
      const stripped = rustName.startsWith(prefix) ? rustName.slice(prefix.length) : rustName;
      return { kind: 'property', pyName: rename ?? explicit?.text ?? stripped };
    }
    if (has(attrs, 'classattr')) return { kind: 'property', pyName: rename ?? rustName };
    return { kind: 'method', pyName: rename ?? rustName };
  }

  function moduleDef(name: Token, attr: Attr): PyModuleDef {
    return {
      rustName: name.text,
      pyName: stringArg(find(attrs, 'pyo3'), 'name') ?? stringArg(attr, 'name') ?? name.text,
      file,
      pos: at(name),
      exports: [],
    };
  }
}

const PY_ITEM_ATTRS_RE = new RegExp(`\\b(${[...PY_ITEM_ATTRS, 'create_exception'].join('|')})\\b`);

function parseAttr(toks: Token[]): Attr {
  let name = '';
  let k = 0;
  while (k < toks.length && (toks[k].kind === 'ident' || toks[k].text === ':')) {
    if (toks[k].kind === 'ident') name = toks[k].text;
    k++;
  }
  const args = toks[k]?.text === '(' ? toks.slice(k + 1, toks.length - 1) : [];
  return { name, args };
}

function has(attrs: Attr[], name: string): boolean {
  return attrs.some((a) => a.name === name);
}

function find(attrs: Attr[], name: string): Attr | undefined {
  return attrs.find((a) => a.name === name);
}

/** The string after `key =` in an attribute's arguments. */
function stringArg(attr: Attr | undefined, key: string): string | undefined {
  if (!attr) return undefined;
  const a = attr.args;
  for (let k = 0; k + 2 < a.length; k++) {
    if (a[k].kind === 'ident' && a[k].text === key && a[k + 1].text === '=' && a[k + 2].kind === 'string') {
      return a[k + 2].text;
    }
  }
  return undefined;
}

/** Index of the bracket closing the one at `open`. */
function matching(toks: Token[], open: number, l: string, r: string): number {
  let d = 0;
  for (let k = open; k < toks.length; k++) {
    if (toks[k].kind !== 'punct') continue;
    if (toks[k].text === l) d++;
    else if (toks[k].text === r && --d === 0) return k;
  }
  return toks.length - 1;
}

/**
 * The first `target` after `from` outside any brackets, stopping (undefined)
 * at `stop` or at a bracket that closes past where the search began.
 */
function findAtLevel(toks: Token[], from: number, target: string, stop: string | undefined): number | undefined {
  let d = 0;
  for (let k = from + 1; k < toks.length; k++) {
    const t = toks[k];
    if (t.kind !== 'punct') continue;
    if (d === 0 && t.text === target) return k;
    if (d === 0 && t.text === stop) return undefined;
    if (t.text === '(' || t.text === '[' || t.text === '{') d++;
    else if (t.text === ')' || t.text === ']' || t.text === '}') {
      if (--d < 0) return undefined;
    }
  }
  return undefined;
}

/** `a::b::C` starting at `k`, as its identifier tokens. */
function pathAt(toks: Token[], k: number): Token[] {
  const path: Token[] = [];
  while (toks[k]?.kind === 'ident') {
    path.push(toks[k]);
    if (toks[k + 1]?.text === ':' && toks[k + 2]?.text === ':') k += 3;
    else break;
  }
  return path;
}

/** The type an `impl` block is for: `impl<T> Foo<T>` and `impl Trait for Foo` both give `Foo`. */
function implOwner(toks: Token[], k: number): string | undefined {
  if (toks[k]?.text === '<') k = matching(toks, k, '<', '>') + 1;
  let owner: string | undefined;
  let angle = 0;
  for (; k < toks.length; k++) {
    const t = toks[k];
    if (t.text === '{' || (t.kind === 'ident' && t.text === 'where')) break;
    if (t.text === '<') angle++;
    else if (t.text === '>') angle--;
    else if (angle === 0 && t.kind === 'ident') {
      if (t.text === 'for') owner = undefined;
      else owner = t.text;
    }
  }
  return owner;
}

/** Flattens a `use` tree into the names it brings in, with the path to each. */
function parseUseTree(
  toks: Token[],
  k: number,
  end: number,
  prefix: string[],
  out: ModuleExport[],
  at: (t: Token) => Position,
): number {
  const segs: string[] = [];
  while (k < end) {
    const t = toks[k];
    if (t.text === '{') {
      k++;
      while (k < end && toks[k].text !== '}') {
        k = parseUseTree(toks, k, end, [...prefix, ...segs], out, at);
        if (toks[k]?.text === ',') k++;
      }
      return k + 1;
    }
    if (t.text === '*') return k + 1;
    if (t.kind !== 'ident') return k;
    segs.push(t.text);
    k++;
    if (toks[k]?.text === ':' && toks[k + 1]?.text === ':') {
      k += 2;
      continue;
    }
    if (toks[k]?.text === 'as') k += 2;
    out.push({ path: [...prefix, ...segs.slice(0, -1)], rustName: t.text, pos: at(t) });
    return k;
  }
  return k;
}

/** How a string literal is used, which decides where its name is looked up. */
export interface LiteralContext {
  /** The literal is the name argument of `getattr`, `call_method*`, `setattr` or `hasattr`. */
  attribute: boolean;
  /**
   * When the attribute is read off a module the same expression imports,
   * that module (a literal, or a `const` of this file), and the names read
   * between the import and this one: `import(M)?.getattr("A")?.getattr("b")`
   * gives `M` and `["A"]` for `"b"`.
   */
  module?: string;
  chain: string[];
  /**
   * The receiver is an imported module this file cannot name, such as
   * `py.import(self.module)`: still a module, so any module will do.
   */
  someModule?: boolean;
}

const ATTRIBUTE_CALLS = new Set(['getattr', 'setattr', 'hasattr', 'call_method', 'call_method0', 'call_method1']);
const STATEMENT_END = new Set([';', '{', '}', '=', ',']);

export function literalContext(toks: Token[], index: number, consts: StrConst[]): LiteralContext {
  let k = index - 1;
  // `intern!(py, "name")` stands for the name itself.
  if (toks[k]?.text === ',' && toks[k - 1]?.text === 'py' && toks[k - 2]?.text === '(' && toks[k - 3]?.text === '!' && toks[k - 4]?.text === 'intern') {
    k -= 5;
  }
  if (toks[k]?.text !== '(' || !ATTRIBUTE_CALLS.has(toks[k - 1]?.text)) return { attribute: false, chain: [] };

  // Walk back along the receiver: `….import(M)?.getattr("A")?.` before this call.
  const chain: string[] = [];
  let depth = 0;
  for (let j = k - 2; j >= 0; j--) {
    const t = toks[j];
    if (t.kind === 'punct') {
      if (t.text === ')') depth++;
      else if (t.text === '(') {
        if (--depth < 0) break;
      } else if (depth === 0 && STATEMENT_END.has(t.text)) break;
      continue;
    }
    if (depth !== 0 || t.kind !== 'ident' || toks[j + 1]?.text !== '(') continue;
    const args = toks.slice(j + 2, matchingClose(toks, j + 1));
    if (ATTRIBUTE_CALLS.has(t.text)) {
      const name = args.find((a) => a.kind === 'string');
      if (!name) break;
      chain.unshift(name.text);
    } else if (t.text === 'import') {
      const lit = args.find((a) => a.kind === 'string');
      const named = lit ? undefined : args.filter((a) => a.kind === 'ident' && a.text !== 'py' && a.text !== 'intern').pop();
      const module = lit?.text ?? consts.find((c) => c.name === named?.text)?.value;
      if (module) return { attribute: true, module, chain };
      return { attribute: true, chain: [], someModule: chain.length === 0 };
    }
  }
  return { attribute: true, chain: [] };
}

function matchingClose(toks: Token[], open: number): number {
  let d = 0;
  for (let k = open; k < toks.length; k++) {
    if (toks[k].kind !== 'punct') continue;
    if (toks[k].text === '(') d++;
    else if (toks[k].text === ')' && --d === 0) return k;
  }
  return toks.length;
}
