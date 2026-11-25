/**
 * Finds the Rust that only exists under `cfg(test)`: items behind
 * `#[cfg(test)]` (a `mod tests { … }`, a helper fn, an impl), a whole file
 * behind `#![cfg(test)]`, and the out-of-line `#[cfg(test)] mod tests;`
 * declarations whose files are test code from top to bottom.
 */
import * as path from 'node:path';
import { type Token, tokenize } from './rustLexer';

export interface TestRegions {
  /** The file opens with `#![cfg(test)]`. */
  wholeFile: boolean;
  /** Source offsets, from the `#` of the attribute to the end of the item. */
  ranges: { start: number; end: number }[];
  /** Names of `#[cfg(test)] mod name;` declared in this file. */
  testModDecls: string[];
}

export function findTestRegions(src: string): TestRegions {
  const toks = tokenize(src);
  const result: TestRegions = { wholeFile: false, ranges: [], testModDecls: [] };
  let braces = 0;
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.kind === 'punct' && t.text === '{') braces++;
    else if (t.kind === 'punct' && t.text === '}') braces--;
    if (!isPunct(t, '#')) {
      i++;
      continue;
    }
    const inner = isPunct(toks[i + 1], '!');
    const open = inner ? i + 2 : i + 1;
    if (!isPunct(toks[open], '[')) {
      i++;
      continue;
    }
    const close = matching(toks, open);
    if (!attrRequiresTest(toks.slice(open + 1, close))) {
      i = close + 1;
      continue;
    }
    if (inner) {
      if (braces === 0) result.wholeFile = true;
      i = close + 1;
      continue;
    }
    const item = itemAfter(toks, close + 1);
    const last = toks[item.end - 1] ?? toks[close];
    result.ranges.push({ start: t.start, end: last.end });
    if (item.modDecl) result.testModDecls.push(item.modDecl);
    // Nested `#[cfg(test)]` inside this item is already covered.
    i = item.end;
  }
  return result;
}

/**
 * The files that may declare the module `file` holds, with the name they
 * would declare it by. `src/a/b.rs` and `src/a/b/mod.rs` are both module `b`,
 * declared in `src/a.rs`, `src/a/mod.rs`, or a crate root in `src/a/`.
 */
export function parentCandidates(file: string): { parent: string; modName: string }[] {
  const base = path.basename(file, '.rs');
  if (base === 'lib' || base === 'main') return [];
  const isModRs = base === 'mod';
  const modName = isModRs ? path.basename(path.dirname(file)) : base;
  const dir = isModRs ? path.dirname(path.dirname(file)) : path.dirname(file);
  return [
    path.join(dir, 'mod.rs'),
    path.join(dir, 'lib.rs'),
    path.join(dir, 'main.rs'),
    `${dir}.rs`,
  ]
    .filter((p) => p !== file)
    .map((parent) => ({ parent, modName }));
}

function isPunct(t: Token | undefined, text: string): boolean {
  return t !== undefined && t.kind === 'punct' && t.text === text;
}

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** Index of the bracket closing the one at `open`, or the last token. */
function matching(toks: Token[], open: number): number {
  const stack: string[] = [];
  for (let j = open; j < toks.length; j++) {
    const t = toks[j];
    if (t.kind !== 'punct') continue;
    if (PAIRS[t.text]) stack.push(PAIRS[t.text]);
    else if (t.text === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return j;
    }
  }
  return toks.length - 1;
}

/** Whether `cfg(…)` (the tokens between `#[` and `]`) is only true under test. */
function attrRequiresTest(args: Token[]): boolean {
  if (args[0]?.kind !== 'ident' || args[0].text !== 'cfg' || !isPunct(args[1], '(')) return false;
  const end = matching(args, 1);
  const preds = splitPredicates(args.slice(2, end));
  return preds.length === 1 && requiresTest(preds[0]);
}

/**
 * True when the predicate can only hold with `test` set: `test` itself, an
 * `all(…)` with such a part, or an `any(…)` made only of such parts.
 */
function requiresTest(pred: Token[]): boolean {
  const head = pred[0];
  if (head?.kind !== 'ident') return false;
  if (pred.length === 1) return head.text === 'test';
  if (!isPunct(pred[1], '(')) return false;
  const parts = splitPredicates(pred.slice(2, matching(pred, 1)));
  if (head.text === 'all') return parts.some(requiresTest);
  if (head.text === 'any') return parts.length > 0 && parts.every(requiresTest);
  return false;
}

/** Splits a comma-separated predicate list at its top level. */
function splitPredicates(toks: Token[]): Token[][] {
  const parts: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const t of toks) {
    if (t.kind === 'punct' && PAIRS[t.text]) depth++;
    else if (t.kind === 'punct' && (t.text === ')' || t.text === ']' || t.text === '}')) depth--;
    if (depth === 0 && isPunct(t, ',')) {
      if (current.length > 0) parts.push(current);
      current = [];
    } else {
      current.push(t);
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/**
 * The extent of the item starting at `from`, past any further attributes:
 * up to its `;` or the `}` closing its body, whichever comes first at the
 * top level. `modDecl` is set for `mod name;`.
 */
function itemAfter(toks: Token[], from: number): { end: number; modDecl?: string } {
  let j = from;
  while (isPunct(toks[j], '#') && isPunct(toks[j + 1], '[')) j = matching(toks, j + 1) + 1;
  const start = j;
  let depth = 0;
  // `{` opens the item's body only outside parentheses and brackets.
  for (; j < toks.length; j++) {
    const t = toks[j];
    if (t.kind !== 'punct') continue;
    if (t.text === '(' || t.text === '[') depth++;
    else if (t.text === ')' || t.text === ']') {
      // The close of an enclosing list: the item was its last element.
      if (--depth < 0) return { end: j };
    } else if (depth === 0 && t.text === '}') return { end: j };
    // A field, variant, or argument ends at its comma.
    else if (depth === 0 && t.text === ',') return { end: j + 1 };
    else if (depth === 0 && t.text === '{') return { end: matching(toks, j) + 1 };
    else if (depth === 0 && t.text === ';') return { end: j + 1, modDecl: modDeclName(toks, start, j) };
  }
  return { end: toks.length };
}

/** `name` when the tokens from `start` up to `semi` are `[pub[(…)]] mod name`. */
function modDeclName(toks: Token[], start: number, semi: number): string | undefined {
  let j = start;
  if (toks[j]?.kind === 'ident' && toks[j].text === 'pub') {
    j++;
    if (isPunct(toks[j], '(')) j = matching(toks, j) + 1;
  }
  const kw = toks[j];
  const name = toks[j + 1];
  if (kw?.kind === 'ident' && kw.text === 'mod' && name?.kind === 'ident' && j + 2 === semi) return name.text;
  return undefined;
}
