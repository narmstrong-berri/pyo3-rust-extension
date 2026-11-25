import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { findTestRegions, parentCandidates } from './testRegions';

/** How far up the module tree a file is checked for a `#[cfg(test)] mod`. */
const MAX_DEPTH = 8;

/**
 * Tints the background of Rust that only compiles under `cfg(test)`, so test
 * code reads apart from the code it tests.
 */
export function registerTestHighlight(context: vscode.ExtensionContext): void {
  const decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('pyo3Boundary.testCodeBackground'),
  });
  const timers = new Map<vscode.TextEditor, NodeJS.Timeout>();

  const enabled = (): boolean =>
    vscode.workspace.getConfiguration('pyo3Boundary').get<boolean>('highlightTestCode', true);

  const paint = async (editor: vscode.TextEditor): Promise<void> => {
    const doc = editor.document;
    if (doc.languageId !== 'rust') return;
    if (!enabled()) {
      editor.setDecorations(decoration, []);
      return;
    }
    const version = doc.version;
    const text = doc.getText();
    const regions = findTestRegions(text);
    const whole = regions.wholeFile || (doc.uri.scheme === 'file' && (await declaredAsTest(doc.uri.fsPath)));
    if (doc.version !== version) return;
    const ranges = whole
      ? [new vscode.Range(0, 0, doc.lineCount - 1, 0)]
      : regions.ranges.map((r) => new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)));
    editor.setDecorations(decoration, ranges);
  };

  const schedule = (editor: vscode.TextEditor, delay: number): void => {
    clearTimeout(timers.get(editor));
    timers.set(
      editor,
      setTimeout(() => {
        timers.delete(editor);
        void paint(editor);
      }, delay),
    );
  };

  const paintVisible = (): void => {
    for (const editor of vscode.window.visibleTextEditors) schedule(editor, 0);
  };

  context.subscriptions.push(
    decoration,
    vscode.window.onDidChangeVisibleTextEditors(paintVisible),
    vscode.workspace.onDidChangeTextDocument((e) => {
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === e.document) schedule(editor, 150);
      }
    }),
    // Saving a parent may add or drop a `#[cfg(test)] mod` for an open child.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === 'rust') paintVisible();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('pyo3Boundary.highlightTestCode')) paintVisible();
    }),
    { dispose: () => timers.forEach(clearTimeout) },
  );
  paintVisible();
}

/**
 * Whether a parent module declares this file behind `#[cfg(test)] mod name;`,
 * directly or through a parent that is itself test-only.
 */
async function declaredAsTest(file: string, depth = 0): Promise<boolean> {
  if (depth >= MAX_DEPTH) return false;
  for (const { parent, modName } of parentCandidates(file)) {
    const src = await readSource(parent);
    if (src === undefined) continue;
    // The first parent that declares the module is the one rustc uses.
    if (!declares(src, modName)) continue;
    const regions = findTestRegions(src);
    return regions.testModDecls.includes(modName) || regions.wholeFile || declaredAsTest(parent, depth + 1);
  }
  return false;
}

function declares(src: string, modName: string): boolean {
  return new RegExp(`\\bmod\\s+${modName}\\s*;`).test(src);
}

async function readSource(file: string): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === file);
  if (open) return open.getText();
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}
