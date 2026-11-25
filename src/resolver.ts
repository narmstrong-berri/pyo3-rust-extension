import * as fs from 'node:fs';
import * as path from 'node:path';
import { type PyDef, type PythonFileIndex, absoluteModule, indexPythonSource } from './pythonIndex';
import type { LiteralContext, ModuleExport, Position, PyItem, PyModuleDef, RustFileIndex } from './rustIndex';

export interface Target {
  file: string;
  pos: Position;
}

/** `[tool.maturin]` from a pyproject.toml: the module's Python name and source root. */
export interface MaturinConfig {
  moduleName?: string;
  pythonSource?: string;
  /** The directory the pyproject.toml is in. */
  dir: string;
}

export function parseMaturinConfig(dir: string, toml: string): MaturinConfig | undefined {
  const section = /^\[tool\.maturin\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml);
  if (!section) return undefined;
  const value = (key: string): string | undefined =>
    new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, 'm').exec(section[1])?.[1];
  return { moduleName: value('module-name'), pythonSource: value('python-source'), dir };
}

const MODULE_NAME = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/;
const IDENTIFIER = /^[A-Za-z_]\w*$/;

/**
 * Everything both directions need: the Rust side's PyO3 items and modules,
 * maturin's naming, and where Python modules live on disk.
 */
export class BoundaryIndex {
  private readonly rust = new Map<string, RustFileIndex>();
  private maturin: MaturinConfig[] = [];
  private roots: string[] = [];
  private readonly pyCache = new Map<string, { mtimeMs: number; index: PythonFileIndex }>();
  private readonly moduleFiles = new Map<string, string | undefined>();
  private pyNames: Set<string> | undefined;

  setRustFile(index: RustFileIndex): void {
    this.rust.set(index.file, index);
    this.pyNames = undefined;
  }

  deleteRustFile(file: string): void {
    this.rust.delete(file);
    this.pyNames = undefined;
  }

  clearRust(): void {
    this.rust.clear();
    this.pyNames = undefined;
  }

  /** Whether any PyO3 item is visible to Python under this name. */
  hasPyName(name: string): boolean {
    this.pyNames ??= new Set(this.allItems().map((it) => it.pyName));
    return this.pyNames.has(name) || (name === '__init__' && this.pyNames.has('__new__'));
  }

  /**
   * Where module names resolve from, in order: the given roots (workspace
   * folders and configured extras), then each maturin project's
   * `python-source`.
   */
  configure(roots: string[], maturin: MaturinConfig[]): void {
    this.maturin = maturin;
    const sources = maturin.map((m) => path.resolve(m.dir, m.pythonSource ?? '.'));
    this.roots = [...new Set([...roots, ...sources].map((r) => path.resolve(r)))];
    this.moduleFiles.clear();
  }

  /** Forgets where modules live, for when Python files are created or deleted. */
  invalidateModules(): void {
    this.moduleFiles.clear();
  }

  get rustFileCount(): number {
    return this.rust.size;
  }

  get itemCount(): number {
    let n = 0;
    for (const f of this.rust.values()) n += f.items.length;
    return n;
  }

  // ---- Python → Rust ----

  /** Every full Python name a `#[pymodule]` is importable as. */
  pyModuleNames(def: PyModuleDef): string[] {
    const named = this.maturin
      .map((m) => m.moduleName)
      .filter((n): n is string => !!n && n.split('.').pop() === def.pyName);
    return named.length > 0 ? named : [def.pyName];
  }

  /** The `#[pymodule]`s importable under `module`. */
  modulesNamed(module: string): PyModuleDef[] {
    const found: PyModuleDef[] = [];
    for (const f of this.rust.values()) {
      for (const m of f.modules) {
        if (this.pyModuleNames(m).includes(module)) found.push(m);
      }
    }
    return found;
  }

  isNativeModule(module: string): boolean {
    return this.modulesNamed(module).length > 0;
  }

  /**
   * The Rust behind `module.qual[0].qual[1]`, e.g. (`litellm.rust_bridge._native`,
   * [`NativeModelCostMap`, `install`]). An unknown module, or a name its
   * exports don't list, falls back to every PyO3 item with that Python name.
   */
  pythonToRust(module: string | undefined, qual: string[]): Target[] {
    if (qual.length === 0) return [];
    let heads: PyItem[] = [];
    let named: Target[] = [];
    if (module) {
      for (const def of this.modulesNamed(module)) {
        for (const exp of def.exports) {
          if (exp.pyName !== undefined) {
            if (exp.pyName !== qual[0]) continue;
            const items = this.itemsForExport(exp, def.file);
            if (items.length > 0) heads.push(...items);
            else named.push({ file: def.file, pos: exp.pos });
          } else {
            heads.push(...this.itemsForExport(exp, def.file).filter((it) => it.pyName === qual[0]));
          }
        }
      }
    }
    if (heads.length === 0 && named.length === 0) {
      // A variant counts here: a stub declares it as a nested class, and the
      // methods it lists are looked up by the variant's own name.
      heads = this.allItems().filter(
        (it) => (it.kind === 'class' || it.kind === 'function' || it.kind === 'variant') && it.pyName === qual[0],
      );
    }
    if (qual.length === 1) return [...named, ...heads.map(toTarget)];

    const owners = new Set(heads.filter((h) => h.kind === 'class').map((h) => h.rustName));
    const member = qual[1] === '__init__' ? '__new__' : qual[1];
    const members = this.allItems().filter(
      (it) => it.owner !== undefined && owners.has(it.owner) && it.pyName === member,
    );
    // A member PyO3 adds itself (`__repr__` from a derive, say) has no Rust of
    // its own; the class is the nearest thing.
    return (members.length > 0 ? members : heads).map(toTarget);
  }

  private allItems(): PyItem[] {
    const all: PyItem[] = [];
    for (const f of this.rust.values()) all.push(...f.items);
    return all;
  }

  /**
   * The items an export names. Several crates can define a type of the same
   * name, so the export's `use` path picks the crate — `crate::` is the
   * module's own, `litellm_host_python::` the crate whose directory ends that
   * name — and then ranks by how much of the rest shows up in the file path.
   */
  private itemsForExport(exp: ModuleExport, moduleFile: string): PyItem[] {
    let candidates = this.allItems().filter(
      (it) => it.rustName === exp.rustName && (it.kind === 'class' || it.kind === 'function'),
    );
    if (candidates.length <= 1) return candidates;
    const head = exp.path[0];
    const sameCrate =
      head === undefined || head === 'crate' || head === 'self' || head === 'super'
        ? (it: PyItem) => crateDir(it.file) === crateDir(moduleFile)
        : (it: PyItem) => {
            const dir = path.basename(crateDir(it.file) ?? '').replace(/-/g, '_');
            return dir !== '' && (head === dir || head.endsWith(`_${dir}`));
          };
    const inCrate = candidates.filter(sameCrate);
    if (inCrate.length > 0) candidates = inCrate;
    if (candidates.length <= 1) return candidates;
    const segs = exp.path.filter((s) => s !== 'crate' && s !== 'self' && s !== 'super');
    const score = (it: PyItem): number => {
      const parts = it.file.split(/[\\/]/).map((p) => p.replace(/\.rs$/, '').replace(/-/g, '_'));
      return segs.filter((s) => parts.includes(s)).length;
    };
    const best = Math.max(...candidates.map(score));
    return candidates.filter((it) => score(it) === best);
  }

  // ---- Rust → Python ----

  /**
   * Where a Rust string literal leads in Python. A module name (`"litellm.x"`)
   * goes to the module. A bare name depends on how it is used:
   *
   * - read off a module the same expression imports, it is looked up there
   *   alone (as a member of a class when the chain reads one first);
   * - read off some other value, it is looked up in the modules this file
   *   imports, at the top level and then as a class member — the value's type
   *   is unknown, so this is a guess, but a guess kept to this file's modules;
   * - anything else (a name handed to a helper, an enum's string form, an
   *   attribute of a module imported by a name only known at runtime) also
   *   tries every module any indexed Rust file imports, since a helper that
   *   forwards a name to `getattr` often lives apart from its callers.
   */
  rustToPython(literal: string, file: RustFileIndex, ctx?: LiteralContext): Target[] {
    if (MODULE_NAME.test(literal)) {
      const module = this.moduleFile(literal);
      if (module) return [{ file: module, pos: { line: 0, character: 0 } }];
    }
    if (!IDENTIFIER.test(literal)) return [];

    if (ctx?.module) {
      if (ctx.chain.length === 0) {
        const hit = this.resolveName(ctx.module, literal, 0);
        return hit ? [hit] : [];
      }
      return this.memberOf(ctx.module, ctx.chain[ctx.chain.length - 1], literal);
    }
    const local = this.moduleLiterals([file]);
    const top = this.lookupIn(local, literal);
    if (top.length > 0) return top;
    const members = this.lookupMembersIn(local, literal);
    if (members.length > 0 || (ctx?.attribute && !ctx.someModule)) return members;
    const everywhere = this.moduleLiterals([...this.rust.values()]).filter((m) => !local.includes(m));
    return this.lookupIn(everywhere, literal);
  }

  /** `member` of the class `cls` that `module` defines or re-exports. */
  private memberOf(module: string, cls: string, member: string): Target[] {
    const where = this.resolveName(module, cls, 0);
    if (!where) return [];
    for (const def of this.pythonIndex(where.file)?.defs.values() ?? []) {
      if (def.line !== where.pos.line) continue;
      const m = def.members?.get(member);
      if (m) return [{ file: where.file, pos: { line: m.line, character: m.character } }];
    }
    return [];
  }

  /** The Python module a Rust constant names, for go to definition on `MODULE`. */
  constToPython(name: string, file: RustFileIndex): Target[] {
    const c = file.consts.find((k) => k.name === name);
    if (!c || !MODULE_NAME.test(c.value)) return [];
    const module = this.moduleFile(c.value);
    return module ? [{ file: module, pos: { line: 0, character: 0 } }] : [];
  }

  /** Module names the files mention, that resolve to a Python file here. */
  private moduleLiterals(files: RustFileIndex[]): string[] {
    const names = new Set<string>();
    for (const f of files) {
      for (const c of f.consts) if (MODULE_NAME.test(c.value)) names.add(c.value);
      for (const l of f.importLiterals) if (MODULE_NAME.test(l)) names.add(l);
    }
    return [...names].filter((n) => this.moduleFile(n) !== undefined);
  }

  private lookupIn(modules: string[], name: string): Target[] {
    const found: Target[] = [];
    for (const m of modules) {
      const hit = this.resolveName(m, name, 0);
      if (hit) found.push(hit);
    }
    return found;
  }

  private lookupMembersIn(modules: string[], name: string): Target[] {
    const found: Target[] = [];
    for (const m of modules) {
      const file = this.moduleFile(m);
      if (!file) continue;
      for (const def of this.pythonIndex(file)?.defs.values() ?? []) {
        const member = def.members?.get(name);
        if (member) found.push({ file, pos: { line: member.line, character: member.character } });
      }
    }
    return found;
  }

  /** `name` in `module`, following `from x import name` re-exports a few hops. */
  resolveName(module: string, name: string, hops: number): Target | undefined {
    const file = this.moduleFile(module);
    if (!file) return undefined;
    const def = this.pythonIndex(file)?.defs.get(name);
    if (!def) return undefined;
    const here = { file, pos: { line: def.line, character: def.character } };
    if (def.kind !== 'import' || !def.from || hops >= 4) return here;
    return this.followImport(def, module, file, hops) ?? here;
  }

  private followImport(def: PyDef, module: string, file: string, hops: number): Target | undefined {
    const isPackage = /^__init__\.pyi?$/.test(path.basename(file));
    const from = absoluteModule(def.from!.module, module, isPackage);
    if (def.from!.name === undefined) {
      const target = this.moduleFile(from);
      return target ? { file: target, pos: { line: 0, character: 0 } } : undefined;
    }
    return (
      this.resolveName(from, def.from!.name, hops + 1) ??
      // `from pkg import submodule`.
      (() => {
        const sub = this.moduleFile(`${from}.${def.from!.name}`);
        return sub ? { file: sub, pos: { line: 0, character: 0 } } : undefined;
      })()
    );
  }

  /** The file a dotted module name resolves to, preferring source over stubs. */
  moduleFile(module: string): string | undefined {
    if (this.moduleFiles.has(module)) return this.moduleFiles.get(module);
    const found = this.findModuleFile(module);
    this.moduleFiles.set(module, found);
    return found;
  }

  private findModuleFile(module: string): string | undefined {
    const rel = module.split('.');
    for (const root of this.roots) {
      const base = path.join(root, ...rel);
      for (const candidate of [`${base}.py`, path.join(base, '__init__.py'), `${base}.pyi`, path.join(base, '__init__.pyi')]) {
        if (isFile(candidate)) return candidate;
      }
    }
    return undefined;
  }

  /**
   * The dotted name of a Python file (or compiled extension) under one of the
   * roots: `litellm/rust_bridge/_native.abi3.so` is `litellm.rust_bridge._native`.
   */
  moduleNameOf(file: string): string | undefined {
    const abs = path.resolve(file);
    // The deepest root wins: a package under `python-source` is not named
    // after the folders above it.
    for (const root of [...this.roots].sort((a, b) => b.length - a.length)) {
      const rel = path.relative(root, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const parts = rel.split(path.sep);
      const last = parts.pop()!;
      const stem = last.split('.')[0];
      if (stem !== '__init__') parts.push(stem);
      if (parts.length > 0 && parts.every((p) => IDENTIFIER.test(p))) return parts.join('.');
    }
    return undefined;
  }

  /** A Python file's index, re-read when the file changes on disk. */
  pythonIndex(file: string): PythonFileIndex | undefined {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      return undefined;
    }
    const cached = this.pyCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached.index;
    const index = indexPythonSource(fs.readFileSync(file, 'utf8'));
    this.pyCache.set(file, { mtimeMs, index });
    return index;
  }
}

/** The crate a Rust file belongs to: the directory holding its `src`. */
function crateDir(file: string): string | undefined {
  const parts = file.split(/[\\/]/);
  const src = parts.lastIndexOf('src');
  return src > 0 ? parts.slice(0, src).join('/') : undefined;
}

function toTarget(it: PyItem): Target {
  return { file: it.file, pos: it.pos };
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
