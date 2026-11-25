/**
 * Just enough of a Rust tokenizer to find PyO3 attributes and string literals:
 * comments are dropped, strings (raw and byte ones included) become one token
 * each, and everything else is an identifier, a number, a lifetime, or a
 * single punctuation character. `::` is two `:` tokens.
 */

export type TokenKind = 'ident' | 'string' | 'punct' | 'number' | 'char' | 'lifetime';

export interface Token {
  kind: TokenKind;
  /** The source text, except for strings, whose text is their contents. */
  text: string;
  /** Offsets into the source, covering the whole token including quotes. */
  start: number;
  end: number;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      // Block comments nest in Rust.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (src[i] === '*' && src[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }

    const raw = rawStringAt(src, i);
    if (raw) {
      tokens.push({ kind: 'string', text: raw.text, start: i, end: raw.end });
      i = raw.end;
      continue;
    }
    if (c === '"' || ((c === 'b' || c === 'c') && src[i + 1] === '"')) {
      const open = c === '"' ? i : i + 1;
      const end = quotedEnd(src, open, '"');
      tokens.push({ kind: 'string', text: src.slice(open + 1, end - 1), start: i, end });
      i = end;
      continue;
    }
    if (c === '\'' || (c === 'b' && src[i + 1] === '\'')) {
      const open = c === '\'' ? i : i + 1;
      const charEnd = charLiteralEnd(src, open);
      if (charEnd !== undefined) {
        tokens.push({ kind: 'char', text: src.slice(i, charEnd), start: i, end: charEnd });
        i = charEnd;
        continue;
      }
      if (c === '\'') {
        let j = i + 1;
        while (j < n && IDENT_PART.test(src[j])) j++;
        tokens.push({ kind: 'lifetime', text: src.slice(i, j), start: i, end: j });
        i = j;
        continue;
      }
    }
    if (c === 'r' && src[i + 1] === '#' && IDENT_START.test(src[i + 2] ?? '')) {
      // A raw identifier: `r#type` names `type`.
      let j = i + 2;
      while (j < n && IDENT_PART.test(src[j])) j++;
      tokens.push({ kind: 'ident', text: src.slice(i + 2, j), start: i, end: j });
      i = j;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(src[j])) j++;
      tokens.push({ kind: 'ident', text: src.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    if (c >= '0' && c <= '9') {
      let j = i + 1;
      while (j < n && (IDENT_PART.test(src[j]) || (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')))) {
        j++;
      }
      tokens.push({ kind: 'number', text: src.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    tokens.push({ kind: 'punct', text: c, start: i, end: i + 1 });
    i++;
  }
  return tokens;
}

/** `r"…"`, `r#"…"#`, `br##"…"##` and the like starting at `i`. */
function rawStringAt(src: string, i: number): { text: string; end: number } | undefined {
  let j = i;
  if (src[j] === 'b' || src[j] === 'c') j++;
  if (src[j] !== 'r') return undefined;
  j++;
  let hashes = 0;
  while (src[j] === '#') {
    hashes++;
    j++;
  }
  if (src[j] !== '"') return undefined;
  const close = '"' + '#'.repeat(hashes);
  const at = src.indexOf(close, j + 1);
  const end = at === -1 ? src.length : at + close.length;
  return { text: src.slice(j + 1, at === -1 ? src.length : at), end };
}

/** Offset just past the closing quote of the literal opened at `open`. */
function quotedEnd(src: string, open: number, quote: string): number {
  let j = open + 1;
  while (j < src.length) {
    if (src[j] === '\\') j += 2;
    else if (src[j] === quote) return j + 1;
    else j++;
  }
  return src.length;
}

/**
 * The end of a char literal opened at `open`, or undefined when the quote
 * starts a lifetime (`'a`, `'static`) instead.
 */
function charLiteralEnd(src: string, open: number): number | undefined {
  if (src[open + 1] === '\\') return quotedEnd(src, open, '\'');
  const cp = src.codePointAt(open + 1);
  if (cp === undefined) return undefined;
  const width = cp > 0xffff ? 2 : 1;
  return src[open + 1 + width] === '\'' ? open + 2 + width : undefined;
}

/** Converts offsets to zero-based line and character positions. */
export class LineMap {
  private readonly starts: number[] = [0];

  constructor(src: string) {
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '\n') this.starts.push(i + 1);
    }
  }

  position(offset: number): { line: number; character: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - this.starts[lo] };
  }

  offset(line: number, character: number): number {
    return (this.starts[line] ?? this.starts[this.starts.length - 1]) + character;
  }
}
