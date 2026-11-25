import { describe, expect, test } from 'vitest';
import { absoluteModule, enclosingClass, indexPythonSource } from '../../src/pythonIndex';

describe('indexPythonSource', () => {
  const src = `"""Module docstring
def not_a_def(): ...
"""
from __future__ import annotations
import os, json as j
import a.b
from .sibling import (
    one,
    two as deux,  # comment
)
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pkg._native import NativeThing
try:
    import fast
except ImportError:
    fast = None

LIMIT: int = 3
answer = 42

def helper(x):
    inner = 1
    def nested(): ...
    return inner

async def fetch():
    pass

class Box(Base):
    """Doc
    def fake(self): ...
    """
    size: int
    count = 0

    def open(self):
        local = 1

    @property
    def label(self) -> str: ...
`;
  const defs = indexPythonSource(src).defs;

  test('lists top-level names, including inside if/try blocks', () => {
    expect([...defs.keys()].sort()).toEqual(
      ['Box', 'LIMIT', 'NativeThing', 'TYPE_CHECKING', 'a', 'annotations', 'answer', 'deux', 'fast', 'fetch', 'helper', 'j', 'one', 'os'].sort(),
    );
  });

  test('records where each import comes from', () => {
    expect(defs.get('deux')).toMatchObject({ kind: 'import', from: { module: '.sibling', name: 'two' } });
    expect(defs.get('j')).toMatchObject({ kind: 'import', from: { module: 'json', name: undefined } });
    expect(defs.get('a')).toMatchObject({ kind: 'import', from: { module: 'a', name: undefined } });
    expect(defs.get('NativeThing')).toMatchObject({ from: { module: 'pkg._native', name: 'NativeThing' } });
  });

  test('keeps the first definition of a name', () => {
    expect(defs.get('fast')).toMatchObject({ kind: 'import', line: 15 });
  });

  test('positions a definition at its name', () => {
    expect(defs.get('helper')).toMatchObject({ kind: 'function', line: 22, character: 4 });
    expect(defs.get('fetch')).toMatchObject({ kind: 'function', line: 27, character: 10 });
  });

  test('lists a class’s members one level down, skipping its docstring', () => {
    const box = defs.get('Box')!;
    expect([...box.members!.keys()]).toEqual(['size', 'count', 'open', 'label']);
    expect(box.members!.get('open')).toMatchObject({ kind: 'function', line: 37, character: 8 });
  });
});

describe('enclosingClass', () => {
  const lines = ['class A:', '    x: int', '    def f(self):', '        return x', 'def g(): ...'];

  test('names the class a member or its body sits in', () => {
    expect(enclosingClass(lines, 1)).toBe('A');
    expect(enclosingClass(lines, 3)).toBe('A');
  });

  test('gives nothing at the top level', () => {
    expect(enclosingClass(lines, 0)).toBeUndefined();
    expect(enclosingClass(lines, 4)).toBeUndefined();
  });
});

describe('absoluteModule', () => {
  test('resolves relative imports from a module and from a package', () => {
    expect(absoluteModule('.sibling', 'pkg.sub.mod', false)).toBe('pkg.sub.sibling');
    expect(absoluteModule('..up', 'pkg.sub.mod', false)).toBe('pkg.up');
    expect(absoluteModule('.child', 'pkg.sub', true)).toBe('pkg.sub.child');
    expect(absoluteModule('.', 'pkg.sub', true)).toBe('pkg.sub');
    expect(absoluteModule('abs.mod', 'pkg', false)).toBe('abs.mod');
  });
});
