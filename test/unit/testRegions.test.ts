import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { findTestRegions, parentCandidates } from '../../src/testRegions';

/** The source text each region covers. */
const covered = (src: string): string[] => findTestRegions(src).ranges.map((r) => src.slice(r.start, r.end));

describe('findTestRegions', () => {
  test('covers a cfg(test) mod from its attribute to its closing brace', () => {
    const src = 'fn a() {}\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() { assert!(true); }\n}\nfn b() {}';
    expect(covered(src)).toEqual(['#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() { assert!(true); }\n}']);
  });

  test('covers other cfg(test) items, past further attributes', () => {
    const src = '#[cfg(test)]\n#[allow(dead_code)]\nfn helper() -> u8 { 1 }\n#[cfg(test)] use std::fmt;';
    expect(covered(src)).toEqual(['#[cfg(test)]\n#[allow(dead_code)]\nfn helper() -> u8 { 1 }', '#[cfg(test)] use std::fmt;']);
  });

  test('reads all/any/not predicates', () => {
    const src = [
      '#[cfg(all(test, feature = "x"))] fn a() {}',
      '#[cfg(any(test, feature = "x"))] fn b() {}',
      '#[cfg(not(test))] fn c() {}',
      '#[cfg(any(test, all(test, unix)))] fn d() {}',
      '#[cfg(feature = "test")] fn e() {}',
    ].join('\n');
    expect(covered(src)).toEqual(['#[cfg(all(test, feature = "x"))] fn a() {}', '#[cfg(any(test, all(test, unix)))] fn d() {}']);
  });

  test('stops a field at its comma and a last field at the closing brace', () => {
    const src = 'struct S {\n    a: u8,\n    #[cfg(test)]\n    b: u8,\n    #[cfg(test)]\n    c: Vec<u8>\n}';
    expect(covered(src)).toEqual(['#[cfg(test)]\n    b: u8,', '#[cfg(test)]\n    c: Vec<u8>']);
  });

  test('does not split a nested cfg(test) out of an outer one', () => {
    const src = '#[cfg(test)]\nmod tests {\n    #[cfg(test)]\n    fn inner() {}\n}';
    expect(findTestRegions(src).ranges).toHaveLength(1);
  });

  test('ignores cfg(test) in comments and strings', () => {
    expect(covered('// #[cfg(test)]\nfn a() {}\nconst S: &str = "#[cfg(test)]";')).toEqual([]);
  });

  test('marks a whole file from a top-level #![cfg(test)]', () => {
    expect(findTestRegions('#![cfg(test)]\nuse super::*;\n').wholeFile).toBe(true);
    expect(findTestRegions('mod m {\n    #![cfg(test)]\n}').wholeFile).toBe(false);
  });

  test('records out-of-line cfg(test) mod declarations', () => {
    const src = '#[cfg(test)]\nmod tests;\n#[cfg(test)]\npub(crate) mod fixtures;\nmod real;';
    expect(findTestRegions(src).testModDecls).toEqual(['tests', 'fixtures']);
  });
});

describe('parentCandidates', () => {
  const p = (...parts: string[]): string => path.join('/w', 'src', ...parts);

  test('looks beside and above a module file', () => {
    expect(parentCandidates(p('a', 'tests.rs'))).toEqual(
      [p('a', 'mod.rs'), p('a', 'lib.rs'), p('a', 'main.rs'), p('a') + '.rs'].map((parent) => ({ parent, modName: 'tests' })),
    );
  });

  test('names a mod.rs after its directory', () => {
    expect(parentCandidates(p('tests', 'mod.rs'))[0]).toEqual({ parent: p('mod.rs'), modName: 'tests' });
  });

  test('gives a crate root no parent', () => {
    expect(parentCandidates(p('lib.rs'))).toEqual([]);
  });
});
