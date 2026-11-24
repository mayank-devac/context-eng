#!/usr/bin/env bash
# One-shot release for context-eng.
#
#   scripts/release.sh            # bump patch (0.1.5 -> 0.1.6), check, publish, update this Mac
#   scripts/release.sh minor      # or: major, or an exact version like 0.2.0
#   scripts/release.sh update     # skip publishing; just install the latest npm version on this Mac
#
# Stops at the first failure. Nothing is published until every check passes.
set -euo pipefail

REGISTRY="https://registry.npmjs.org"
cd "$(dirname "$0")/.."

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

update_device() {
  local version="$1"
  say "Installing context-eng@$version globally on this device"
  npm install -g "context-eng@$version" --prefer-online --registry "$REGISTRY"

  # vite-plus can point its shim back at an older Node during its own updates.
  local shim="$HOME/.vite-plus/bin/context-eng"
  local npm_bin
  npm_bin="$(npm prefix -g)/bin/context-eng"
  if [[ -L "$shim" && -e "$npm_bin" && "$(readlink "$shim")" != "$npm_bin" ]]; then
    say "Repointing $shim -> $npm_bin (was $(readlink "$shim"))"
    ln -sf "$npm_bin" "$shim"
  fi

  local installed
  installed="$(node -p "require('$(npm root -g)/context-eng/package.json').version")"
  say "Installed version: $installed (on PATH: $(command -v context-eng))"

  say "Running context-eng doctor"
  context-eng doctor || true

  printf '\nDone. Restart Claude Code / Codex / Cursor so they load the new MCP server.\n'
}

BUMP="${1:-patch}"

if [[ "$BUMP" == "update" ]]; then
  update_device latest
  exit 0
fi

say "Pre-flight"
npm whoami --registry "$REGISTRY" >/dev/null 2>&1 || die "Not logged in to npm. Run: npm login"
[[ "$(git branch --show-current)" == "master" ]] || die "Switch to master first."

if [[ -n "$(git status --porcelain)" ]]; then
  git status --short
  read -r -p "These changes will be included in the release commit. Continue? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || die "Cancelled."
fi

say "Installing dependencies"
npm ci

say "Lint, typecheck, test"
npm run lint
npm run typecheck
npm run typecheck:test
npm test

say "Bumping version ($BUMP)"
VERSION="$(npm version "$BUMP" --no-git-tag-version | sed 's/^v//')"
# The MCP server reports its own version; keep it in sync with package.json.
sed -i '' -E "s/version: \"[0-9]+\.[0-9]+\.[0-9]+[^\"]*\"/version: \"$VERSION\"/" src/mcp.ts
grep -q "version: \"$VERSION\"" src/mcp.ts || die "Could not update the version in src/mcp.ts"
npm view "context-eng@$VERSION" version --registry "$REGISTRY" >/dev/null 2>&1 \
  && die "context-eng@$VERSION is already on npm."

say "Building and checking the package contents"
npm run build
npm pack --dry-run

read -r -p "Publish context-eng@$VERSION to npm? [y/N] " answer
[[ "$answer" =~ ^[Yy]$ ]] || die "Cancelled before publishing. Version files were bumped; undo with: git checkout package.json package-lock.json src/mcp.ts"

say "Committing and tagging v$VERSION"
git add -A
git commit -m "Release $VERSION" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git tag "v$VERSION"

say "Publishing to npm (enter your one-time code if npm asks)"
npm publish --registry "$REGISTRY"

say "Pushing commit and tag"
git push origin master
git push origin "v$VERSION"

update_device "$VERSION"
