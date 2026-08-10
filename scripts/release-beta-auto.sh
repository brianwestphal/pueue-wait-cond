#!/usr/bin/env bash
#
# Non-interactive beta release for pueue-wait-cond.
#
# Same outcome as `npm run release:beta`, but answers every prompt itself, so it
# can run from automation, a cron, or an assistant told to "cut a beta".
#
# Why a separate script rather than piping answers into release.sh: that one is a
# resumable state machine with several `read`-driven branches — the version menu,
# the editor loop and its confirm, the proceed confirm, and the resume prompt.
# Which answers are correct depends on the saved .release-state.json, so
# echo-piping them is brittle. Re-implementing just the beta path is cleaner than
# bending the interactive script into something it isn't.
#
# What it does:
#   1. Preflight: clean tree (a HARD fail here, unlike the interactive version
#      which asks), on main/master, node present, tags fetched.
#   2. Pick the version: --version X.Y.Z or a bare positional wins. Otherwise
#      package.json's version if it has not already shipped as a stable tag — it
#      IS the upcoming release — else the next patch.
#   3. Notes: --notes <file>, --notes-stdin, or a deterministic `git log` list.
#   4. Gates: lint, typecheck, unit + E2E.
#   5. Write the version, prepend to CHANGELOG.md, commit.
#   6. Auto-increment the beta number, annotated tag, push commit + tag.
#
# Usage:
#   bash scripts/release-beta-auto.sh [X.Y.Z] [--version X.Y.Z]
#                                     [--notes FILE | --notes-stdin]
#                                     [--skip-gates] [--dry-run]
#
# Exit codes:
#   0 — pushed (or --dry-run completed); CI is running.
#   1 — preflight / argument failure.
#   2 — gates failed.
#   3 — git commit, tag or push failed.
#
set -euo pipefail
cd "$(dirname "$0")/.."

CHANGELOG="CHANGELOG.md"

# Colors off on a non-tty so captured logs stay readable.
if [[ -t 1 ]]; then
  BOLD="\033[1m"; DIM="\033[2m"; GREEN="\033[32m"; YELLOW="\033[33m"
  RED="\033[31m"; CYAN="\033[36m"; RESET="\033[0m"
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; RESET=""
fi

info()    { echo -e "${CYAN}${BOLD}>>>${RESET} $1"; }
success() { echo -e "${GREEN}${BOLD}>>>${RESET} $1"; }
warn()    { echo -e "${YELLOW}${BOLD}>>>${RESET} $1"; }
error()   { echo -e "${RED}${BOLD}>>>${RESET} $1" >&2; }

VERSION=""
NOTES=""
NOTES_FILE=""
NOTES_STDIN=false
SKIP_GATES=false
DRY_RUN=false

set_version_arg() {
  [[ -z "$VERSION" ]] || { error "Version given more than once."; exit 1; }
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    error "Version must be X.Y.Z (got '$1'). The -beta.N suffix is added for you."
    exit 1
  }
  VERSION="$1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)     set_version_arg "${2:-}"; shift 2 ;;
    --notes)       NOTES_FILE="${2:-}"; shift 2 ;;
    --notes-stdin) NOTES_STDIN=true; shift ;;
    --skip-gates)  SKIP_GATES=true; shift ;;
    --dry-run)     DRY_RUN=true; shift ;;
    -h|--help)     sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)            error "Unrecognized flag: $1"; exit 1 ;;
    *)             set_version_arg "$1"; shift ;;
  esac
done

# --- Preflight --------------------------------------------------------------
preflight() {
  info "Pre-flight..."
  [[ -f package.json ]] || { error "No package.json — run from the project root."; exit 1; }
  command -v node >/dev/null || { error "node is required."; exit 1; }

  # Hard fail, unlike the interactive script: nobody is here to judge whether
  # the stray changes belong in the release.
  if [[ -n "$(git status --porcelain)" ]]; then
    error "Working tree is not clean. Commit or stash first:"
    git status --short >&2
    exit 1
  fi

  local branch; branch=$(git branch --show-current)
  if [[ "$branch" != "main" && "$branch" != "master" ]]; then
    error "On branch '${branch}', not main/master. Refusing to auto-release."
    exit 1
  fi

  git fetch --tags --prune origin 2>/dev/null || warn "git fetch failed — using the local tag list."
  success "Pre-flight OK (branch=${branch})"
}

# --- Target version ---------------------------------------------------------
read_version() {
  if [[ -n "$VERSION" ]]; then
    info "Version from arguments: ${BOLD}${VERSION}${RESET}"
    return
  fi
  local current; current=$(node -p "require('./package.json').version")
  if git rev-parse "v${current}" >/dev/null 2>&1; then
    # Already shipped as stable, so the next beta belongs to the next patch.
    local major minor patch
    IFS='.' read -r major minor patch <<< "$current"
    VERSION="${major}.${minor}.$((patch + 1))"
    info "v${current} is already tagged; targeting ${BOLD}${VERSION}${RESET}"
  else
    VERSION="$current"
    info "package.json is the upcoming release: ${BOLD}${VERSION}${RESET}"
  fi
}

# --- Notes ------------------------------------------------------------------
draft_notes() {
  if [[ "$NOTES_STDIN" == "true" ]]; then
    NOTES=$(cat)
  elif [[ -n "$NOTES_FILE" ]]; then
    [[ -f "$NOTES_FILE" ]] || { error "No such notes file: $NOTES_FILE"; exit 1; }
    NOTES=$(cat "$NOTES_FILE")
  else
    local anchor range
    anchor=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo "")
    range="HEAD"; [[ -n "$anchor" ]] && range="${anchor}..HEAD"
    info "Drafting notes from ${BOLD}${range}${RESET}"
    NOTES=$(gitgist "$range" 2>/dev/null || true)
  fi

  if [[ -z "${NOTES//[[:space:]]/}" ]]; then
    NOTES="- Maintenance release (no user-facing changes recorded)."
    warn "GitGist returned no release notes; using a placeholder."
  fi
}

# --- Gates ------------------------------------------------------------------
run_gates() {
  if [[ "$SKIP_GATES" == "true" ]]; then
    warn "Skipping gates (--skip-gates). CI still runs them on the tag."
    return
  fi
  local gate
  for gate in "npm run lint" "npm run typecheck" "npm test"; do
    info "Gate: ${DIM}${gate}${RESET}"
    if ! $gate; then
      error "Gate failed: ${gate}"
      exit 2
    fi
  done
  success "Gates passed"
}

# --- Tag --------------------------------------------------------------------
resolve_tag() {
  local n=1
  while git rev-parse "v${VERSION}-beta.${n}" >/dev/null 2>&1; do n=$((n + 1)); done
  echo "v${VERSION}-beta.${n}"
}

apply_version() {
  info "Writing version ${BOLD}${VERSION}${RESET}..."
  npm version "$VERSION" --no-git-tag-version --allow-same-version > /dev/null

  local label date tmp
  label="${TAG#v}"
  date=$(date +%Y-%m-%d)
  [[ -f "$CHANGELOG" ]] || printf '# Changelog\n\n' > "$CHANGELOG"
  tmp=$(mktemp -t pwc-changelog)
  {
    head -n 1 "$CHANGELOG"
    printf '\n## %s — %s\n\n' "$label" "$date"
    printf '%s\n' "$NOTES"
    tail -n +2 "$CHANGELOG"
  } > "$tmp"
  mv "$tmp" "$CHANGELOG"
  success "package.json, package-lock.json and ${CHANGELOG} updated"
}

commit_tag_push() {
  git add package.json package-lock.json "$CHANGELOG" 2>/dev/null || true
  if git diff --cached --quiet; then
    warn "Nothing to commit (files already current)."
  else
    git commit -m "release: ${TAG}" || { error "git commit failed."; exit 3; }
    success "Committed"
  fi

  printf '%s\n' "$NOTES" | git tag -a "$TAG" -F - || { error "git tag failed."; exit 3; }
  success "Tagged ${TAG}"

  git push || { error "git push failed. Tag exists locally: git tag -d ${TAG}"; exit 3; }
  git push origin "$TAG" || {
    error "Tag push failed. Retry: git push origin ${TAG}"
    error "Unwind:              git tag -d ${TAG}"
    exit 3
  }
  success "${TAG} pushed."
}

# --- Main -------------------------------------------------------------------
echo ""
echo -e "${BOLD}  pueue-wait-cond — Automated Beta Release${RESET}"
echo ""

preflight
read_version
draft_notes
TAG=$(resolve_tag)

echo ""
echo -e "  ${DIM}Version:${RESET} ${BOLD}${VERSION}${RESET}"
echo -e "  ${DIM}Tag:${RESET}     ${BOLD}${TAG}${RESET}"
echo -e "  ${DIM}Notes:${RESET}"
printf '%s\n' "$NOTES" | sed 's/^/    /'
echo ""

run_gates

if [[ "$DRY_RUN" == "true" ]]; then
  warn "--dry-run: stopping before any file is written, committed or pushed."
  echo ""
  echo -e "  ${DIM}Would write version${RESET} ${BOLD}${VERSION}${RESET} ${DIM}and tag${RESET} ${BOLD}${TAG}${RESET}"
  exit 0
fi

apply_version
commit_tag_push

echo ""
echo -e "  ${DIM}CI (release.yml) will publish${RESET} ${BOLD}pueue-wait-cond@${TAG#v}${RESET} ${DIM}under the${RESET} ${BOLD}beta${RESET} ${DIM}dist-tag.${RESET}"
echo -e "  ${DIM}Monitor:${RESET} https://github.com/brianwestphal/pueue-wait-cond/actions"
echo -e "  ${DIM}Unwind:${RESET}  git push origin :refs/tags/${TAG} && git tag -d ${TAG}"
echo ""
success "Done."
