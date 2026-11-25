import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { queriesAt, stubQual, wordAt } from './pythonCursor';
import { type MaturinConfig, BoundaryIndex, type Target, parseMaturinConfig } from './resolver';
import { indexRustSource, literalContext } from './rustIndex';
import { tokenize } from './rustLexer';
import { registerTestHighlight } from './testHighlight';

const index = new BoundaryIndex();
let log: vscode.LogOutputChannel;
let ready: Promise<void> = Promise.resolve();
/**
 * Non-zero while this extension asks the other definition providers for their
 * answer. That request reaches this provider too, which must stay out of it.
 */
let askingOthers = 0;

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel('PyO3 Boundary', { log: true });
  context.subscriptions.push(log);
  ready = rebuild();

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider({ language: 'python' }, { provideDefinition: pythonDefinition }),
    vscode.languages.registerDefinitionProvider({ language: 'rust' }, { provideDefinition: rustDefinition }),
    vscode.commands.registerCommand('pyo3Boundary.rebuildIndex', () => {
      ready = rebuild();
      return ready;
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('pyo3Boundary')) ready = rebuild();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      ready = rebuild();
    }),
  );

  const rs = vscode.workspace.createFileSystemWatcher('**/*.rs');
  rs.onDidCreate((uri) => void reindexRust(uri));
  rs.onDidChange((uri) => void reindexRust(uri));
  rs.onDidDelete((uri) => index.deleteRustFile(uri.fsPath));
  const pyproject = vscode.workspace.createFileSystemWatcher('**/pyproject.toml');
  const reconfigure = (): void => void configure();
  pyproject.onDidCreate(reconfigure);
  pyproject.onDidChange(reconfigure);
  pyproject.onDidDelete(reconfigure);
  const py = vscode.workspace.createFileSystemWatcher('**/*.{py,pyi}', false, true, false);
  py.onDidCreate(() => index.invalidateModules());
  py.onDidDelete(() => index.invalidateModules());
  context.subscriptions.push(rs, pyproject, py);
  registerTestHighlight(context);
}

export function deactivate(): void {}

function exclude(): string {
  return vscode.workspace
    .getConfiguration('pyo3Boundary')
    .get<string>('exclude', '{**/target/**,**/node_modules/**,**/.git/**,**/.venv/**}');
}

/** Directory names the exclude glob drops, for filtering watcher events. */
function excludedDirs(): Set<string> {
  return new Set([...exclude().matchAll(/\*\*\/([^/{},*]+)\/\*\*/g)].map((m) => m[1]));
}

async function configure(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const extra = vscode.workspace.getConfiguration('pyo3Boundary').get<string[]>('pythonRoots', []);
  const roots = folders.flatMap((f) => [
    f.uri.fsPath,
    ...extra.map((r) => path.resolve(f.uri.fsPath, r)),
  ]);
  const maturin: MaturinConfig[] = [];
  for (const uri of await vscode.workspace.findFiles('**/pyproject.toml', exclude())) {
    try {
      const config = parseMaturinConfig(path.dirname(uri.fsPath), await fs.promises.readFile(uri.fsPath, 'utf8'));
      if (config) maturin.push(config);
    } catch (err) {
      log.warn(`cannot read ${uri.fsPath}: ${String(err)}`);
    }
  }
  index.configure(roots, maturin);
  log.info(
    `roots: ${roots.join(', ') || '(none)'}; maturin modules: ${
      maturin.map((m) => m.moduleName ?? '(unnamed)').join(', ') || '(none)'
    }`,
  );
}

async function rebuild(): Promise<void> {
  const start = Date.now();
  await configure();
  const files = await vscode.workspace.findFiles('**/*.rs', exclude());
  index.clearRust();
  const BATCH = 64;
  for (let i = 0; i < files.length; i += BATCH) {
    await Promise.all(files.slice(i, i + BATCH).map((uri) => reindexRust(uri, true)));
  }
  log.info(
    `indexed ${index.rustFileCount} Rust file(s), ${index.itemCount} PyO3 item(s) in ${Date.now() - start}ms`,
  );
}

async function reindexRust(uri: vscode.Uri, known = false): Promise<void> {
  if (!known && uri.fsPath.split(path.sep).some((part) => excludedDirs().has(part))) return;
  try {
    const src = await fs.promises.readFile(uri.fsPath, 'utf8');
    index.setRustFile(indexRustSource(uri.fsPath, src));
  } catch (err) {
    log.warn(`cannot index ${uri.fsPath}: ${String(err)}`);
  }
}

function toLocation(t: Target): vscode.Location {
  return new vscode.Location(vscode.Uri.file(t.file), new vscode.Position(t.pos.line, t.pos.character));
}

function dedupe(targets: Target[]): Target[] {
  const seen = new Set<string>();
  return targets.filter((t) => {
    const key = `${t.file}:${t.pos.line}:${t.pos.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function pythonDefinition(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): Promise<vscode.Location[] | undefined> {
  if (askingOthers > 0) return undefined;
  await ready;
  const own = index.moduleNameOf(doc.uri.fsPath);
  const isPackage = /^__init__\.pyi?$/.test(path.basename(doc.uri.fsPath));
  const queries = queriesAt(doc.getText(), pos.line, pos.character, own, isPackage, (m) =>
    index.isNativeModule(m),
  );
  let targets = queries.flatMap((q) => index.pythonToRust(q.module, q.qual));
  // Asking the language server costs a second lookup, so only for a name
  // some PyO3 item actually goes by.
  const word = doc.getWordRangeAtPosition(pos);
  if (targets.length === 0 && word && index.hasPyName(doc.getText(word))) {
    targets = await viaLanguageServer(doc, pos);
  }
  if (targets.length > 0) log.debug(`python ${doc.uri.fsPath}:${pos.line + 1} → ${targets.length} Rust target(s)`);
  return dedupe(targets).map(toLocation);
}

/**
 * Asks the other providers (Pylance) where the name goes, and maps an answer
 * that lands in a native module's stub, or in the compiled module itself,
 * onto the Rust behind it. This is what follows a method called on a value.
 */
async function viaLanguageServer(doc: vscode.TextDocument, pos: vscode.Position): Promise<Target[]> {
  let found: (vscode.Location | vscode.LocationLink)[] | undefined;
  askingOthers++;
  try {
    found = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      'vscode.executeDefinitionProvider',
      doc.uri,
      pos,
    );
  } catch (err) {
    log.debug(`definition providers failed: ${String(err)}`);
  } finally {
    askingOthers--;
  }
  const targets: Target[] = [];
  for (const loc of found ?? []) {
    const uri = 'targetUri' in loc ? loc.targetUri : loc.uri;
    const range = 'targetUri' in loc ? (loc.targetSelectionRange ?? loc.targetRange) : loc.range;
    const file = uri.fsPath;
    const module = index.moduleNameOf(file);
    if (!module) continue;
    if (file.endsWith('.pyi')) {
      if (!index.isNativeModule(module)) continue;
      let lines: string[];
      try {
        lines = (await fs.promises.readFile(file, 'utf8')).split(/\r?\n/);
      } catch {
        continue;
      }
      const at = wordAt(lines[range.start.line] ?? '', range.start.character);
      if (!at) continue;
      targets.push(...index.pythonToRust(module, stubQual(lines, range.start.line, at.word)));
    } else if (/\.(so|pyd)$/.test(file)) {
      const word = doc.getText(doc.getWordRangeAtPosition(pos));
      if (word) targets.push(...index.pythonToRust(module, [word]));
    }
  }
  return targets;
}

async function rustDefinition(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): Promise<vscode.Location[] | undefined> {
  await ready;
  const text = doc.getText();
  // Read from the editor, so an unsaved edit counts.
  const file = indexRustSource(doc.uri.fsPath, text);
  index.setRustFile(file);
  const offset = doc.offsetAt(pos);
  const toks = tokenize(text);
  const at = toks.findIndex((t) => t.start <= offset && offset < t.end);
  if (at === -1) return undefined;
  const token = toks[at];
  const targets =
    token.kind === 'string'
      ? index.rustToPython(token.text, file, literalContext(toks, at, file.consts))
      : token.kind === 'ident'
        ? index.constToPython(token.text, file)
        : [];
  if (targets.length > 0) log.debug(`rust ${doc.uri.fsPath}:${pos.line + 1} → ${targets.length} Python target(s)`);
  return dedupe(targets).map(toLocation);
}
