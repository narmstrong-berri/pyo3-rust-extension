/**
 * The names a Python module (or stub) defines, read line by line. It sees
 * what is written at the top level, including inside top-level `if`/`try`
 * blocks, and one level into each class. That is what Rust reaches by
 * `getattr` and what a stub declares; anything subtler is left to Pylance.
 */

export interface PyDef {
  name: string;
  kind: 'function' | 'class' | 'variable' | 'import';
  line: number;
  character: number;
  /** Methods and attributes, for a class. */
  members?: Map<string, PyDef>;
  /** For an import: the module (possibly relative, e.g. `..x`) and the name in it. */
  from?: { module: string; name: string | undefined };
}

export interface PythonFileIndex {
  defs: Map<string, PyDef>;
}

const DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/;
const CLASS = /^(\s*)class\s+([A-Za-z_]\w*)/;
const ASSIGN = /^(\s*)([A-Za-z_]\w*)\s*(?::[^=]*)?=(?!=)/;
const ANNOTATION = /^(\s*)([A-Za-z_]\w*)\s*:\s*[^=]+$/;
const FROM_IMPORT = /^(\s*)from\s+(\.*[\w.]*)\s+import\s+(.*)$/;
const IMPORT = /^(\s*)import\s+(.*)$/;
const BLOCK_HEADER = /^(if|elif|else|try|except|finally|with)\b/;

export function indexPythonSource(src: string): PythonFileIndex {
  const defs = new Map<string, PyDef>();
  const lines = src.split(/\r?\n/);
  // The class whose body we are in, and the indent of that body.
  let cls: { def: PyDef; indent: number | undefined } | undefined;
  // Whether the last top-level line opened an `if`/`try`/`with`, whose body
  // counts as top level, and the indent of that body.
  let topBlock = false;
  let topBlockIndent: number | undefined;
  // The quotes of a string that runs past the end of the line, such as a docstring.
  let inString: string | undefined;

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (inString) {
      if (line.includes(inString)) inString = undefined;
      continue;
    }
    inString = openString(line);
    const stripped = line.trim();
    if (stripped === '' || stripped.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      cls = undefined;
      topBlock = BLOCK_HEADER.test(stripped);
      topBlockIndent = undefined;
    }
    if (cls && indent > 0) {
      cls.indent ??= indent;
      if (indent === cls.indent) {
        const m = DEF.exec(line) ?? CLASS.exec(line) ?? ASSIGN.exec(line) ?? ANNOTATION.exec(line);
        if (m && !cls.def.members!.has(m[2])) {
          const kind = DEF.test(line) ? 'function' : CLASS.test(line) ? 'class' : 'variable';
          cls.def.members!.set(m[2], { name: m[2], kind, line: n, character: m[1].length + line.slice(m[1].length).indexOf(m[2]) });
        }
      }
      continue;
    }

    // Top level, or the body of a top-level `if`/`try`/`with`.
    if (indent > 0) {
      if (!topBlock) continue;
      topBlockIndent ??= indent;
      if (indent !== topBlockIndent) continue;
    } else if (topBlock) {
      continue;
    }

    const imp = FROM_IMPORT.exec(line);
    if (imp) {
      let names = imp[3];
      // A parenthesised list can run over several lines.
      if (names.includes('(') && !names.includes(')')) {
        while (n + 1 < lines.length && !names.includes(')')) {
          names += ' ' + lines[++n];
        }
      }
      for (const part of names.replace(/[()]/g, ' ').split(',')) {
        const m = /^\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*(?:#.*)?$/.exec(part);
        if (!m) continue;
        const local = m[2] ?? m[1];
        const col = line.indexOf(local);
        set(defs, { name: local, kind: 'import', line: n, character: Math.max(0, col), from: { module: imp[2], name: m[1] } });
      }
      continue;
    }
    const plain = IMPORT.exec(line);
    if (plain) {
      for (const part of plain[2].split(',')) {
        const m = /^\s*([\w.]+)(?:\s+as\s+([A-Za-z_]\w*))?/.exec(part);
        if (!m) continue;
        // `import a.b` binds `a`; `import a.b as c` binds `c` to `a.b`.
        const local = m[2] ?? m[1].split('.')[0];
        const module = m[2] ? m[1] : local;
        set(defs, { name: local, kind: 'import', line: n, character: indent, from: { module, name: undefined } });
      }
      continue;
    }
    const cm = CLASS.exec(line);
    if (cm) {
      const def: PyDef = { name: cm[2], kind: 'class', line: n, character: indent + 'class '.length, members: new Map() };
      set(defs, def);
      if (indent === 0) cls = { def, indent: undefined };
      continue;
    }
    const dm = DEF.exec(line);
    if (dm) {
      set(defs, { name: dm[2], kind: 'function', line: n, character: line.indexOf(dm[2], indent) });
      continue;
    }
    const am = ASSIGN.exec(line) ?? ANNOTATION.exec(line);
    if (am) set(defs, { name: am[2], kind: 'variable', line: n, character: indent });
  }
  return { defs };
}

/** The triple quote a line leaves open, if it opens one more than it closes. */
function openString(line: string): string | undefined {
  for (const q of ['"""', "'''"]) {
    if (line.split(q).length % 2 === 0) return q;
  }
  return undefined;
}

/** The first definition of a name wins: later ones are usually fallbacks. */
function set(defs: Map<string, PyDef>, def: PyDef): void {
  if (!defs.has(def.name)) defs.set(def.name, def);
}

/**
 * The class a line sits in, by indentation: the nearest line above with less
 * indent that opens a class. Used to qualify a stub method, so `install` on a
 * line inside `class NativeModelCostMap:` becomes `NativeModelCostMap.install`.
 */
export function enclosingClass(lines: string[], line: number): string | undefined {
  const text = lines[line] ?? '';
  let indent = text.length - text.trimStart().length;
  for (let n = line - 1; n >= 0 && indent > 0; n--) {
    const l = lines[n];
    if (l.trim() === '') continue;
    const i = l.length - l.trimStart().length;
    if (i >= indent) continue;
    const m = CLASS.exec(l);
    if (m) return m[2];
    indent = i;
  }
  return undefined;
}

/** Resolves `from ..x import y` against the module it is written in. */
export function absoluteModule(relative: string, inModule: string, isPackage: boolean): string {
  const dots = /^\.*/.exec(relative)![0].length;
  if (dots === 0) return relative;
  const parts = inModule.split('.');
  // A package's `__init__` is the package itself, so one dot stays in it.
  const keep = parts.length - (isPackage ? dots - 1 : dots);
  const base = parts.slice(0, Math.max(0, keep));
  const rest = relative.slice(dots);
  return [...base, ...(rest ? [rest] : [])].join('.');
}
