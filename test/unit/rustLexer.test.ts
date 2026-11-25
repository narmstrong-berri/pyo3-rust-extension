import { describe, expect, test } from 'vitest';
import { LineMap, tokenize } from '../../src/rustLexer';

const kinds = (src: string): string[] => tokenize(src).map((t) => `${t.kind}:${t.text}`);

describe('tokenize', () => {
  test('drops line and nested block comments', () => {
    expect(kinds('a // "not a string"\n/* x /* y */ "z" */ b')).toEqual(['ident:a', 'ident:b']);
  });

  test('keeps a URL inside a string whole', () => {
    expect(kinds('"http://x" c')).toEqual(['string:http://x', 'ident:c']);
  });

  test('reads raw, byte and escaped strings as one token each', () => {
    expect(kinds('r#"a "quoted" b"# br"x" b"y" "q\\"r"')).toEqual([
      'string:a "quoted" b',
      'string:x',
      'string:y',
      'string:q\\"r',
    ]);
  });

  test('tells a lifetime from a char literal', () => {
    expect(kinds("&'a str, 'b', '\\n', 'static")).toEqual([
      'punct:&',
      "lifetime:'a",
      'ident:str',
      'punct:,',
      "char:'b'",
      'punct:,',
      "char:'\\n'",
      'punct:,',
      "lifetime:'static",
    ]);
  });

  test('reads a raw identifier as the identifier', () => {
    expect(kinds('r#type')).toEqual(['ident:type']);
  });

  test('keeps a range apart from its numbers', () => {
    expect(kinds('0..10 1.5')).toEqual(['number:0', 'punct:.', 'punct:.', 'number:10', 'number:1.5']);
  });
});

describe('LineMap', () => {
  test('maps offsets to positions and back', () => {
    const src = 'ab\ncd\n\nef';
    const map = new LineMap(src);
    expect(map.position(src.indexOf('d'))).toEqual({ line: 1, character: 1 });
    expect(map.position(src.indexOf('e'))).toEqual({ line: 3, character: 0 });
    expect(map.offset(1, 1)).toBe(src.indexOf('d'));
  });
});
