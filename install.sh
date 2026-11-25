#!/usr/bin/env bash
# Compiles, packages, and installs the extension into this container's VS Code
# server, or into desktop VS Code where there is no server (e.g. on a Mac).
set -euo pipefail

cd "$(dirname "$0")"

npm run compile
npx --yes @vscode/vsce package --out release.vsix
vsix="$PWD/release.vsix"
echo "VSIX: $vsix"

# The bin directory is named after the VS Code commit, so it changes whenever
# VS Code updates. Take the most recent one.
cli=$(ls -dt "$HOME"/.vscode-server/bin/*/bin/code-server 2>/dev/null | head -1 || true)
# No server: desktop VS Code, through `code` on PATH or, on a Mac where the
# shell command was never installed, the CLI inside the app bundle.
if [ -z "$cli" ]; then
  for candidate in \
    "$(command -v code || true)" \
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      cli=$candidate
      break
    fi
  done
fi
if [ -z "$cli" ]; then
  echo "No VS Code found: no server under ~/.vscode-server/bin and no desktop 'code' CLI" >&2
  exit 1
fi

"$cli" --install-extension "$vsix" --force
echo "Installed $vsix with $cli. Run 'Developer: Reload Window' in VS Code to load it."
