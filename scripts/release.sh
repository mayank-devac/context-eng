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
  if [[ "$version" != "latest" ]]; then
    # A fresh publish can take a few minutes before npm will serve it.
    say "Waiting for npm to make context-eng@$version available"
    local tries=0
    until npm view "context-eng@$version" version --prefer-online --registry "$REGISTRY" >/dev/null 2>&1; do
      tries=$((tries + 1))
      (( tries > 40 )) && die "context-eng@$version is still not available after 10 minutes. Run later: npm run update-device"
      printf '.'
      sleep 15
    done
    printf '\n'
  fi
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

# Safe quit: Ctrl+C (or any failure) undoes whatever is still local.
#   checks     nothing changed yet
#   bumped     version files edited          -> restore them
#   committed  release commit + tag local    -> drop both, restore files
#   publishing npm publish running           -> can't tell if it landed; say how to check
#   published  on npm, not fully on GitHub   -> can't unpublish; print the remaining steps
#   done       release finished              -> nothing to undo
STAGE="checks"
VERSION=""
WORK_DIR="$(mktemp -d)"
VERSION_FILES=(package.json package-lock.json src/mcp.ts)

finish_hint() {
  printf '  git push --atomic origin master v%s\n' "$VERSION"
  printf '  gh release create v%s --verify-tag --generate-notes\n' "$VERSION"
  printf '  npm run update-device\n'
}

on_exit() {
  local status=$?
  trap - EXIT INT TERM
  if (( status != 0 )); then
    case "$STAGE" in
      bumped|committed)
        if [[ "$STAGE" == "committed" ]]; then
          git tag -d "v$VERSION" >/dev/null 2>&1 || true
          git reset --mixed -q HEAD~1
        fi
        for f in "${VERSION_FILES[@]}"; do cp "$WORK_DIR/backup/$f" "$f"; done
        printf '\n\033[1;33mStopped. Nothing was published; the version bump%s was undone.\033[0m\n' \
          "$([[ "$STAGE" == "committed" ]] && echo ', release commit and tag')"
        ;;
      publishing)
        printf '\n\033[1;33mStopped during npm publish. Check whether it landed:\033[0m\n'
        printf '  npm view context-eng@%s version\n' "$VERSION"
        printf 'If it shows %s, finish the release with:\n' "$VERSION"
        finish_hint
        printf 'If not, undo locally with:\n  git tag -d v%s && git reset --mixed HEAD~1\n' "$VERSION"
        ;;
      published)
        printf '\n\033[1;33mStopped. context-eng@%s is already on npm (that cannot be undone).\033[0m\n' "$VERSION"
        printf 'Finish the release with:\n'
        finish_hint
        ;;
      done)
        printf '\n\033[1;33mStopped after the release finished. To update this Mac: npm run update-device\033[0m\n'
        ;;
    esac
  fi
  rm -rf "$WORK_DIR"
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

say "Pre-flight"
npm whoami --registry "$REGISTRY" >/dev/null 2>&1 || die "Not logged in to npm. Run: npm login"
command -v gh >/dev/null 2>&1 || die "GitHub CLI not found. Install it: brew install gh"
gh auth status >/dev/null 2>&1 || die "Not logged in to GitHub. Run: gh auth login"
[[ "$(git branch --show-current)" == "master" ]] || die "Switch to master first."

# Catch a behind/diverged master now, not after npm already has the new version.
git fetch origin master --tags --quiet
[[ "$(git rev-list --count HEAD..origin/master)" == "0" ]] \
  || die "Local master is behind origin/master. Run: git pull --rebase"
PREV_TAG="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true)"

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
mkdir -p "$WORK_DIR/backup/src"
for f in "${VERSION_FILES[@]}"; do cp "$f" "$WORK_DIR/backup/$f"; done
STAGE="bumped"
VERSION="$(npm version "$BUMP" --no-git-tag-version | sed 's/^v//')"
# The MCP server reports its own version; keep it in sync with package.json.
sed -i '' -E "s/version: \"[0-9]+\.[0-9]+\.[0-9]+[^\"]*\"/version: \"$VERSION\"/" src/mcp.ts
grep -q "version: \"$VERSION\"" src/mcp.ts || die "Could not update the version in src/mcp.ts"
npm view "context-eng@$VERSION" version --registry "$REGISTRY" >/dev/null 2>&1 \
  && die "context-eng@$VERSION is already on npm."
git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null \
  && die "Tag v$VERSION already exists locally."
[[ -z "$(git ls-remote --tags origin "refs/tags/v$VERSION")" ]] \
  || die "Tag v$VERSION already exists on GitHub."

say "Building and checking the package contents"
npm run build
npm pack --dry-run

read -r -p "Publish context-eng@$VERSION to npm? [y/N] " answer
[[ "$answer" =~ ^[Yy]$ ]] || die "Cancelled before publishing."

say "Committing and tagging v$VERSION"
git add -A
git commit -m "Release $VERSION" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
STAGE="committed"
git tag -a "v$VERSION" -m "Release $VERSION"

say "Publishing to npm (enter your one-time code if npm asks)"
STAGE="publishing"
npm publish --registry "$REGISTRY"
STAGE="published"

say "Pushing commit and tag"
# --atomic: either both master and the tag land on GitHub, or neither does.
git push --atomic origin master "v$VERSION"

say "Creating GitHub release v$VERSION"
NOTES_FILE="$WORK_DIR/notes.md"
TARBALL_DIR="$WORK_DIR/tarball"
mkdir -p "$TARBALL_DIR"
{
  printf '## Changes\n\n'
  if [[ -n "$PREV_TAG" ]]; then
    git log --no-merges --pretty='- %s (%h)' "$PREV_TAG..v$VERSION^"
    printf '\n**Full diff:** https://github.com/mayank-devac/context-eng/compare/%s...v%s\n' "$PREV_TAG" "$VERSION"
  else
    git log --no-merges --pretty='- %s (%h)' "v$VERSION^"
  fi
  printf '\n**npm:** https://www.npmjs.com/package/context-eng/v/%s\n' "$VERSION"
} > "$NOTES_FILE"
npm pack --pack-destination "$TARBALL_DIR" >/dev/null
if ! gh release create "v$VERSION" "$TARBALL_DIR"/*.tgz \
    --verify-tag --latest --title "v$VERSION" --notes-file "$NOTES_FILE"; then
  printf '\n\033[1;33mWarning: npm and the tag are published, but the GitHub release failed.\033[0m\n'
  printf 'Retry with: gh release create v%s --verify-tag --generate-notes\n' "$VERSION"
fi
STAGE="done"

update_device "$VERSION"
