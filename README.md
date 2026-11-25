# PyO3 Boundary Navigation

Go to definition across the PyO3 boundary, in both directions:

- **Python → Rust.** On a name from a native module — imported from it,
  read off it, declared in its `.pyi` stub, or reached through a value whose
  type Pylance knows — Go to Definition offers the Rust that implements it
  next to whatever Pylance found.
- **Rust → Python.** On a string literal Rust hands to Python — a module name
  in `import(…)` or a `const`, a name passed to `getattr`/`call_method*`, or
  one passed to a helper that does — Go to Definition opens the Python it
  names. On a `const` holding a module name, it opens that module.

It also tints the background of Rust that only compiles under `cfg(test)`:
an item behind `#[cfg(test)]` (a `mod tests { … }`, a helper, a field), a
file opening with `#![cfg(test)]`, and a file a parent declares with
`#[cfg(test)] mod name;`. `cfg(all(test, …))` counts; `cfg(not(test))` does
not. Turn it off with `pyo3Boundary.highlightTestCode`, or change the color
through `workbench.colorCustomizations` → `pyo3Boundary.testCodeBackground`.

Nothing else is changed: Pylance and rust-analyzer keep their own answers, and
this one is added to them (VS Code shows a peek list when there are several).

## How it finds things

### The Rust side

Every `.rs` file in the workspace is tokenized (comments and strings handled,
no compilation) and read for:

| Rust | Python name |
| --- | --- |
| `#[pyclass]` struct or enum | its name, or `name = "…"` |
| a variant of a `#[pyclass]` enum | `Enum.Variant` |
| `#[pyfunction]` | its name, or `#[pyo3(name = "…")]` |
| a fn in `#[pymethods]` | its name; `#[new]` is `__new__`/`__init__`; `#[getter]`/`#[setter]` drop `get_`/`set_` or take the name given |
| a field marked `#[pyo3(get)]`/`set`, or any field under `#[pyclass(get_all)]` | the field name |
| `create_exception!(module, Name, Base)` | `Name` |

A `#[pymodule]`'s contents come from `#[pymodule_export] use …` trees, items
declared inside a declarative module, `wrap_pyfunction!`/`add_class::<…>()`
in a function module, and `set_item("Name", py.get_type::<…>())`. Its full
Python name comes from maturin's `module-name` in `pyproject.toml`. When two
crates define a type of the same name, the export's `use` path decides: a
`crate::` path is the module's own crate, an external one is the crate whose
directory ends the crate name.

### The Python side

Python files are read line by line for top-level names (including inside
top-level `if`/`try`), one level into classes, and imports, which are followed
through re-exports. Module names resolve against the workspace folders,
maturin's `python-source`, and `pyo3Boundary.pythonRoots`.

### Rust → Python lookups

A bare name's meaning depends on how Rust uses it:

- `py.import(M)?.getattr("x")` — `x` in `M` only. A chain such as
  `import(M)?.getattr("Cls")?.getattr("method")` finds the method on the class.
- `py.import(self.module)?.getattr("x")` — a module, but one chosen at run
  time: every module any indexed Rust file imports.
- `value.getattr("x")` on anything else — the value's type is unknown, so only
  the modules this file imports are tried, never the whole workspace. Most
  such names (`get`, `append`, `status_code`) have no answer, and none is given.
- A literal that is not an attribute name (`host::call(py, "install", …)`, an
  enum's `#[strum(serialize = "…")]`) — this file's modules first, then every
  module any Rust file imports.

## Limits

- Names built at run time (`format!`, variables) can't be followed.
- A method called on a Python value from Rust is a guess within the file's
  modules, as above.
- Python → Rust through a value (`self.cost_map.install(…)`) needs Pylance:
  this extension asks it where the name goes and maps an answer landing in a
  native stub or compiled module. Without Pylance, only imports and attribute
  access on imported names are followed.
- Types declared only in a stub (`TypedDict`, `Protocol`) have no Rust, so
  only Pylance's answer appears.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `pyo3Boundary.pythonRoots` | `[]` | Extra directories module names resolve from, relative to each workspace folder. |
| `pyo3Boundary.exclude` | `{**/target/**,**/node_modules/**,**/.git/**,**/.venv/**}` | Rust and `pyproject.toml` files left out of the index. |
| `pyo3Boundary.highlightTestCode` | `true` | Tint the background of `cfg(test)`-only Rust. |

**PyO3 Boundary: Rebuild Index** re-reads everything; the index otherwise
follows file changes on its own. The **PyO3 Boundary** output channel logs
what was indexed.

## Development

```sh
npm install
npm test          # Vitest over the indexers and the resolver
./install.sh      # compile, package, and install into VS Code
```
