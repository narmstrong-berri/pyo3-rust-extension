import { absoluteModule, enclosingClass, indexPythonSource } from './pythonIndex';

/** A name to look up on the Rust side: a module and the dotted path in it. */
export interface Query {
  module: string;
  qual: string[];
}

const WORD = /[A-Za-z_]\w*/g;

/** The identifier covering `character` on `line`, with its start column. */
export function wordAt(line: string, character: number): { word: string; start: number } | undefined {
  for (const m of line.matchAll(WORD)) {
    const start = m.index!;
    if (character >= start && character <= start + m[0].length) return { word: m[0], start };
  }
  return undefined;
}

/**
 * What a Python cursor names in a native module, from this file alone:
 *
 * - inside the module's own stub, the declaration under the cursor, qualified
 *   by its class;
 * - a name imported from a native module (`from …_native import X`);
 * - an attribute of one: `_native.X`, or `X.method` where `X` came from one.
 *
 * Anything reached through a value (`self.cost_map.install`) needs types,
 * which is what the language server is asked for when this finds nothing.
 */
export function queriesAt(
  text: string,
  line: number,
  character: number,
  ownModule: string | undefined,
  ownIsPackage: boolean,
  isNative: (module: string) => boolean,
): Query[] {
  const lines = text.split(/\r?\n/);
  const at = wordAt(lines[line] ?? '', character);
  if (!at) return [];
  const { word, start } = at;

  if (ownModule && isNative(ownModule)) {
    return [{ module: ownModule, qual: stubQual(lines, line, word) }];
  }

  const defs = indexPythonSource(text).defs;
  const imported = (local: string): { module: string; name: string | undefined } | undefined => {
    const def = defs.get(local);
    if (def?.kind !== 'import' || !def.from) return undefined;
    const module = ownModule
      ? absoluteModule(def.from.module, ownModule, ownIsPackage)
      : def.from.module;
    return { module, name: def.from.name };
  };
  /** The native module a local name is bound to, if it is one. */
  const nativeModuleBoundTo = (local: string): string | undefined => {
    const imp = imported(local);
    if (!imp) return undefined;
    const full = imp.name === undefined ? imp.module : `${imp.module}.${imp.name}`;
    return isNative(full) ? full : undefined;
  };

  const before = (lines[line] ?? '').slice(0, start);
  const owner = /([A-Za-z_]\w*)\s*\.\s*$/.exec(before)?.[1];
  if (owner) {
    const module = nativeModuleBoundTo(owner);
    if (module) return [{ module, qual: [word] }];
    const imp = imported(owner);
    if (imp?.name && isNative(imp.module)) return [{ module: imp.module, qual: [imp.name, word] }];
    return [];
  }

  const imp = imported(word);
  if (imp?.name && isNative(imp.module)) return [{ module: imp.module, qual: [imp.name] }];
  return [];
}

/**
 * The dotted name a stub line declares. A name declared inside a class is
 * that class's member; a name merely mentioned there (an annotation, say)
 * refers to something at the top level.
 */
export function stubQual(lines: string[], line: number, word: string): string[] {
  const text = lines[line] ?? '';
  const declares = new RegExp(
    `^\\s*(?:(?:async\\s+)?def\\s+${word}\\b|class\\s+${word}\\b|${word}\\s*[:=])`,
  ).test(text);
  const cls = enclosingClass(lines, line);
  return declares && cls && cls !== word ? [cls, word] : [word];
}
