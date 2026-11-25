import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { queriesAt } from '../../src/pythonCursor';
import { BoundaryIndex, parseMaturinConfig } from '../../src/resolver';
import { indexRustSource, literalContext } from '../../src/rustIndex';
import { tokenize } from '../../src/rustLexer';

/**
 * A miniature of the layout PyO3 projects use: a maturin package whose native
 * module is `pkg._native`, a stub for it, Python host modules the Rust calls
 * into, and two crates that both define a `Cache` type.
 */
const FILES: Record<string, string> = {
  'pyproject.toml': `[project]
name = "pkg"

[tool.maturin]
module-name = "pkg._native"
python-source = "python"
features = ["x"]
`,
  'python/pkg/__init__.py': 'from .host.settings import http_settings as http\n',
  'python/pkg/_native.pyi': `class Widget:
    def __new__(cls, x: int) -> Widget: ...
    @property
    def size(self) -> int: ...
    def run(self) -> Cache: ...

class Cache: ...
def gil_stats() -> dict: ...
`,
  'python/pkg/host/__init__.py': '',
  'python/pkg/host/settings.py': `def http_settings():
    return {}

class Spec:
    timeout: float
    def describe(self): ...
`,
  'python/pkg/host/routes.py': 'def map_failure(error): ...\n',
  'python/pkg/user.py': `from pkg._native import Widget, gil_stats as stats
from pkg import _native as native

w = Widget(1)
w.run()
Widget.run
native.Cache
stats()
`,
  'crates/bridge/src/lib.rs': `
#[pymodule]
mod _native {
    #[pymodule_export]
    use crate::widget::Widget;
    #[pymodule_export]
    use crate::cache::Cache;
    #[pymodule_export]
    use crate::diagnostics::gil_stats;
}`,
  'crates/bridge/src/widget.rs': `
#[pyclass]
pub struct Widget {}

#[pymethods]
impl Widget {
    #[new]
    fn new(x: u8) -> Self { Widget {} }
    #[getter]
    fn get_size(&self) -> u8 { 0 }
    fn run(&self) {}
}`,
  'crates/bridge/src/cache.rs': '#[pyclass]\npub struct Cache {}\n',
  'crates/other/src/cache.rs': '#[pyclass]\npub struct Cache {}\n',
  'crates/bridge/src/diagnostics.rs': '#[pyfunction]\npub fn gil_stats() {}\n',
  'crates/bridge/src/settings.rs': `
const MODULE: &str = "pkg.host.settings";
fn read(py: Python) {
    py.import(MODULE)?.getattr("http_settings")?;
    py.import(MODULE)?.getattr("Spec")?.getattr("describe")?;
    spec.getattr("timeout")?;
    other.getattr("http_settings")?;
}`,
  'crates/bridge/src/routes.rs': `
const ROUTES: &str = "pkg.host.routes";
fn imported(py: Python) { py.import(ROUTES)?; }`,
  'crates/bridge/src/failure.rs': `
fn fail(py: Python, module: &str) {
    py.import(module)?.getattr("map_failure")?;
    helper(py, "map_failure");
    error.getattr("map_failure")?;
}`,
};

describe('BoundaryIndex', () => {
  let root: string;
  let index: BoundaryIndex;
  const rel = (t: { file: string; pos: { line: number } }): string =>
    `${path.relative(root, t.file)}:${t.pos.line}`;
  const rustFile = (name: string) => indexRustSource(path.join(root, name), FILES[name]);
  /** Rust → Python from the literal `literal`, the `nth` occurrence in the file. */
  const fromRust = (name: string, literal: string, nth = 0): string[] => {
    const toks = tokenize(FILES[name]);
    const at = toks.filter((t) => t.kind === 'string' && t.text === literal)[nth];
    const file = rustFile(name);
    return index.rustToPython(literal, file, literalContext(toks, toks.indexOf(at), file.consts)).map(rel);
  };

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pyo3-boundary-')));
    for (const [name, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), content);
    }
    index = new BoundaryIndex();
    for (const name of Object.keys(FILES).filter((n) => n.endsWith('.rs'))) index.setRustFile(rustFile(name));
    index.configure([root], [parseMaturinConfig(root, FILES['pyproject.toml'])!]);
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('reads maturin’s section and nothing past it', () => {
    expect(parseMaturinConfig('/x', FILES['pyproject.toml'])).toEqual({
      moduleName: 'pkg._native',
      pythonSource: 'python',
      dir: '/x',
    });
    expect(parseMaturinConfig('/x', '[project]\nname = "y"\n')).toBeUndefined();
  });

  test('names the native module after maturin’s module-name', () => {
    expect(index.isNativeModule('pkg._native')).toBe(true);
    expect(index.isNativeModule('_native')).toBe(false);
  });

  test('maps Python names to module files, under maturin’s python-source', () => {
    expect(index.moduleNameOf(path.join(root, 'python/pkg/_native.pyi'))).toBe('pkg._native');
    expect(index.moduleNameOf(path.join(root, 'python/pkg/_native.abi3.so'))).toBe('pkg._native');
    expect(index.moduleNameOf(path.join(root, 'python/pkg/host/__init__.py'))).toBe('pkg.host');
    expect(rel({ file: index.moduleFile('pkg.host')!, pos: { line: 0 } })).toBe('python/pkg/host/__init__.py:0');
    expect(index.moduleFile('pkg.missing')).toBeUndefined();
  });

  describe('Python → Rust', () => {
    test('finds a class, its constructor, getter and method', () => {
      expect(index.pythonToRust('pkg._native', ['Widget']).map(rel)).toEqual(['crates/bridge/src/widget.rs:2']);
      expect(index.pythonToRust('pkg._native', ['Widget', '__init__']).map(rel)).toEqual(['crates/bridge/src/widget.rs:7']);
      expect(index.pythonToRust('pkg._native', ['Widget', 'size']).map(rel)).toEqual(['crates/bridge/src/widget.rs:9']);
      expect(index.pythonToRust('pkg._native', ['Widget', 'run']).map(rel)).toEqual(['crates/bridge/src/widget.rs:10']);
    });

    test('picks the definition the export’s use path points at', () => {
      expect(index.pythonToRust('pkg._native', ['Cache']).map(rel)).toEqual(['crates/bridge/src/cache.rs:1']);
    });

    test('falls back to every item of that name for a module it does not know', () => {
      expect(index.pythonToRust(undefined, ['Cache']).map(rel).sort()).toEqual([
        'crates/bridge/src/cache.rs:1',
        'crates/other/src/cache.rs:1',
      ]);
    });

    test('lands on the class for a member PyO3 adds itself', () => {
      expect(index.pythonToRust('pkg._native', ['Widget', '__repr__']).map(rel)).toEqual(['crates/bridge/src/widget.rs:2']);
    });
  });

  describe('Python cursor', () => {
    const user = FILES['python/pkg/user.py'];
    const lines = user.split('\n');
    const at = (line: number, word: string, nth = 0) => {
      let col = -1;
      for (let k = 0; k <= nth; k++) col = lines[line].indexOf(word, col + 1);
      return queriesAt(user, line, col + 1, 'pkg.user', false, (m) => index.isNativeModule(m));
    };

    test('follows names imported from the native module', () => {
      expect(at(0, 'Widget')).toEqual([{ module: 'pkg._native', qual: ['Widget'] }]);
      expect(at(7, 'stats')).toEqual([{ module: 'pkg._native', qual: ['gil_stats'] }]);
    });

    test('follows attributes of the module and of its classes', () => {
      expect(at(6, 'Cache')).toEqual([{ module: 'pkg._native', qual: ['Cache'] }]);
      expect(at(5, 'run')).toEqual([{ module: 'pkg._native', qual: ['Widget', 'run'] }]);
    });

    test('leaves a method called on a value to the language server', () => {
      expect(at(4, 'run')).toEqual([]);
    });

    test('qualifies a declaration in the stub by its class', () => {
      const stub = FILES['python/pkg/_native.pyi'];
      const q = (line: number, word: string) =>
        queriesAt(stub, line, stub.split('\n')[line].indexOf(word) + 1, 'pkg._native', false, (m) => index.isNativeModule(m));
      expect(q(4, 'run')).toEqual([{ module: 'pkg._native', qual: ['Widget', 'run'] }]);
      // A name only mentioned in a member's annotation is the top-level one.
      expect(q(4, 'Cache')).toEqual([{ module: 'pkg._native', qual: ['Cache'] }]);
      expect(q(7, 'gil_stats')).toEqual([{ module: 'pkg._native', qual: ['gil_stats'] }]);
    });
  });

  describe('Rust → Python', () => {
    test('opens a module named by a literal or a constant', () => {
      expect(fromRust('crates/bridge/src/settings.rs', 'pkg.host.settings')).toEqual(['python/pkg/host/settings.py:0']);
      expect(index.constToPython('MODULE', rustFile('crates/bridge/src/settings.rs')).map(rel)).toEqual([
        'python/pkg/host/settings.py:0',
      ]);
    });

    test('reads a name off the module the expression imports', () => {
      expect(fromRust('crates/bridge/src/settings.rs', 'http_settings')).toEqual(['python/pkg/host/settings.py:0']);
      expect(fromRust('crates/bridge/src/settings.rs', 'describe')).toEqual(['python/pkg/host/settings.py:5']);
    });

    test('guesses an attribute of a value from this file’s modules alone', () => {
      expect(fromRust('crates/bridge/src/settings.rs', 'timeout')).toEqual(['python/pkg/host/settings.py:4']);
      expect(fromRust('crates/bridge/src/failure.rs', 'map_failure', 2)).toEqual([]);
    });

    test('looks everywhere for a module named at runtime or a name handed to a helper', () => {
      expect(fromRust('crates/bridge/src/failure.rs', 'map_failure', 0)).toEqual(['python/pkg/host/routes.py:0']);
      expect(fromRust('crates/bridge/src/failure.rs', 'map_failure', 1)).toEqual(['python/pkg/host/routes.py:0']);
    });

    test('follows a re-export to its definition', () => {
      expect(index.resolveName('pkg', 'http', 0)).toMatchObject({ pos: { line: 0 } });
      expect(rel(index.resolveName('pkg', 'http', 0)!)).toBe('python/pkg/host/settings.py:0');
    });
  });
});
