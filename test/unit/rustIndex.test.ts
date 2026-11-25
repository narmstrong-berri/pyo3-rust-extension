import { describe, expect, test } from 'vitest';
import { indexRustSource, literalContext } from '../../src/rustIndex';
import { tokenize } from '../../src/rustLexer';

const items = (src: string) =>
  indexRustSource('lib.rs', src).items.map((it) => ({
    kind: it.kind,
    rust: it.rustName,
    py: it.pyName,
    ...(it.owner ? { owner: it.owner } : {}),
    line: it.pos.line,
  }));

describe('indexRustSource', () => {
  test('names a class by its pyclass name and module', () => {
    const index = indexRustSource(
      'lib.rs',
      '#[pyclass(frozen, name = "AtomicApplied", module = "pkg._native")]\npub(crate) struct PyAtomicApplied { inner: u8 }',
    );
    expect(index.items).toMatchObject([
      { kind: 'class', rustName: 'PyAtomicApplied', pyName: 'AtomicApplied', pyModule: 'pkg._native', pos: { line: 1 } },
    ]);
  });

  test('applies PyO3’s naming rules to methods', () => {
    const src = `
#[pymethods]
impl<T: Send> Widget<T> {
    #[new]
    #[pyo3(signature = (x, *, y = None))]
    fn new(x: u8, y: Option<u8>) -> Self { todo!() }
    #[getter]
    fn get_size(&self) -> u8 { 0 }
    #[getter(colour)]
    fn paint(&self) -> u8 { 0 }
    #[setter]
    fn set_size(&mut self, v: u8) {}
    #[pyo3(name = "run")]
    fn run_inner(&self) { fn nested() {} }
    #[staticmethod]
    fn make() {}
    #[classattr]
    const LIMIT: u8 = 3;
}`;
    expect(items(src)).toEqual([
      { kind: 'constructor', rust: 'new', py: '__new__', owner: 'Widget', line: 5 },
      { kind: 'property', rust: 'get_size', py: 'size', owner: 'Widget', line: 7 },
      { kind: 'property', rust: 'paint', py: 'colour', owner: 'Widget', line: 9 },
      { kind: 'property', rust: 'set_size', py: 'size', owner: 'Widget', line: 11 },
      { kind: 'method', rust: 'run_inner', py: 'run', owner: 'Widget', line: 13 },
      { kind: 'method', rust: 'make', py: 'make', owner: 'Widget', line: 15 },
    ]);
  });

  test('takes the type after `for` in a trait impl', () => {
    expect(items('#[pymethods]\nimpl Display for Thing { fn shown(&self) {} }')).toEqual([
      { kind: 'method', rust: 'shown', py: 'shown', owner: 'Thing', line: 1 },
    ]);
  });

  test('exposes fields marked get or set, or all of them under get_all', () => {
    const src = `
#[pyclass]
struct A {
    #[pyo3(get, name = "id")]
    pub ident: u64,
    hidden: Vec<(u8, u8)>,
    #[pyo3(set)] value: u8,
}
#[pyclass(get_all)]
struct B { x: u8, y: u8 }`;
    expect(items(src).filter((i) => i.kind === 'property')).toEqual([
      { kind: 'property', rust: 'ident', py: 'id', owner: 'A', line: 4 },
      { kind: 'property', rust: 'value', py: 'value', owner: 'A', line: 6 },
      { kind: 'property', rust: 'x', py: 'x', owner: 'B', line: 9 },
      { kind: 'property', rust: 'y', py: 'y', owner: 'B', line: 9 },
    ]);
  });

  test('lists the variants of a pyclass enum', () => {
    const src = `#[pyclass(name = "Send")]
enum NativeSend {
    Now(),
    #[pyo3(name = "Before")]
    PreCall(Py<Request>),
    Later { at: u64 },
}`;
    expect(items(src).filter((i) => i.kind === 'variant')).toEqual([
      { kind: 'variant', rust: 'Now', py: 'Now', owner: 'NativeSend', line: 2 },
      { kind: 'variant', rust: 'PreCall', py: 'Before', owner: 'NativeSend', line: 4 },
      { kind: 'variant', rust: 'Later', py: 'Later', owner: 'NativeSend', line: 5 },
    ]);
  });

  test('records functions and exceptions', () => {
    const src = `
#[pyfunction]
#[pyo3(name = "gil_stats")]
fn stats() {}
pyo3::create_exception!(
    _native,
    RustBridgeDeclined,
    pyo3::exceptions::PyException,
    "doc"
);`;
    expect(items(src)).toEqual([
      { kind: 'function', rust: 'stats', py: 'gil_stats', line: 3 },
      { kind: 'class', rust: 'RustBridgeDeclined', py: 'RustBridgeDeclined', line: 6 },
    ]);
  });

  test('reads a declarative module’s exports from its use trees and items', () => {
    const src = `
#[pymodule(gil_used = true)]
mod _native {
    #[pymodule_export]
    use crate::redis::store::{
        NativePending, router_cooldowns::NativeRouterCooldowns as Cooldowns,
    };
    use pyo3::prelude::*;
    #[pymodule_export]
    use crate::db::NativeDatabase;
    #[pyfunction]
    fn inline_fn() {}
    #[pymodule_init]
    fn init(module: &Bound<'_, PyModule>) -> PyResult<()> {
        module.dict().set_item("_Runtime", py.get_type::<crate::secrets::NativeSecretManager>())
    }
}`;
    const [module] = indexRustSource('lib.rs', src).modules;
    expect(module.pyName).toBe('_native');
    expect(module.exports.map((e) => ({ path: e.path.join('::'), name: e.rustName, py: e.pyName }))).toEqual([
      { path: 'crate::redis::store', name: 'NativePending', py: undefined },
      { path: 'crate::redis::store::router_cooldowns', name: 'NativeRouterCooldowns', py: undefined },
      { path: 'crate::db', name: 'NativeDatabase', py: undefined },
      { path: '', name: 'inline_fn', py: undefined },
      { path: 'crate::secrets', name: 'NativeSecretManager', py: '_Runtime' },
    ]);
  });

  test('reads a function module’s registrations', () => {
    const src = `
#[pymodule]
#[pyo3(name = "fast")]
fn fast_impl(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(ops::double, m)?)?;
    m.add_class::<shapes::Circle>()?;
    Ok(())
}`;
    const [module] = indexRustSource('lib.rs', src).modules;
    expect(module.pyName).toBe('fast');
    expect(module.exports.map((e) => `${e.path.join('::')}::${e.rustName}`)).toEqual(['ops::double', 'shapes::Circle']);
  });

  test('collects string constants and import literals, but not const generics', () => {
    const src = `
const MODULE: &str = "litellm.rust_bridge.host.settings";
pub(crate) const OTHER: &'static str = "x";
fn f<const N: usize>() { let s = "after = here"; }
fn g(py: Python) { py.import("threading"); PyModule::import(py, "json"); }`;
    const index = indexRustSource('lib.rs', src);
    expect(index.consts.map((c) => [c.name, c.value])).toEqual([
      ['MODULE', 'litellm.rust_bridge.host.settings'],
      ['OTHER', 'x'],
    ]);
    expect(index.importLiterals).toEqual(['threading', 'json']);
  });

  test('skips files with nothing PyO3 or Python in them', () => {
    expect(indexRustSource('plain.rs', 'fn main() { println!("hi"); }').items).toEqual([]);
  });
});

describe('literalContext', () => {
  const context = (src: string, literal: string) => {
    const toks = tokenize(src);
    const index = toks.findIndex((t) => t.kind === 'string' && t.text === literal);
    return literalContext(toks, index, indexRustSource('lib.rs', src).consts);
  };

  test('names the module an import chain reads from', () => {
    const src = 'const M: &str = "pkg.host"; fn f() { py.import(M)?.getattr("Cls")?.call_method1("run", ())?; }';
    expect(context(src, 'Cls')).toEqual({ attribute: true, module: 'pkg.host', chain: [] });
    expect(context(src, 'run')).toEqual({ attribute: true, module: 'pkg.host', chain: ['Cls'] });
  });

  test('sees through intern! and a literal module name', () => {
    expect(context('fn f() { PyModule::import(py, "pkg.x")?.getattr(intern!(py, "y")) }', 'y')).toEqual({
      attribute: true,
      module: 'pkg.x',
      chain: [],
    });
  });

  test('marks a module only known at runtime', () => {
    expect(context('fn f() { py.import(self.module)?.getattr("map_failure") }', 'map_failure')).toEqual({
      attribute: true,
      chain: [],
      someModule: true,
    });
  });

  test('marks an attribute of a value', () => {
    expect(context('fn f() { let v = error.value(py); v.getattr("headers") }', 'headers')).toEqual({
      attribute: true,
      chain: [],
    });
  });

  test('marks a literal that is not an attribute name', () => {
    expect(context('fn f() { host::call(py, "install", args) }', 'install')).toEqual({ attribute: false, chain: [] });
  });
});
