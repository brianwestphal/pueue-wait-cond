#!/usr/bin/env bash
#
# Interactive release for pueue-wait-cond.
#
#   npm run release        stable: bump version, changelog, commit, tag v{ver}
#   npm run release:beta   beta:   same, but tag v{ver}-beta.N
#
# Resumable: progress lives in .release-state.json, so aborting mid-flow picks up
# where it left off instead of re-asking everything.
#
# Modelled on ~/Documents/{kerf,news}/scripts/release.sh, minus what this project
# does not have. Differences worth knowing:
#
#  1. ONE version file. kerf syncs three package.json files plus an ai/ bundle,
#     news also writes tauri.conf.json and Cargo.toml. Here it is package.json
#     and package-lock.json, which `npm version` handles by itself.
#
#  2. NO gitgist. Those repos draft notes with an AI helper that is not a
#     dependency here, so notes are pre-filled from `git log` and edited by hand.
#
#  3. THE TAG IS THE TRIGGER. This script never publishes. Pushing v* starts
#     .github/workflows/release.yml, which re-runs the gates and publishes to npm
#     with provenance. Local gates here are a fast fail, not the authority.
#
#  4. STABLE PUSHES v{ver} DIRECTLY. news pushes v{ver}-rc.N and lets CI promote
#     after smoke-testing the published artifact. That pipeline does not exist
#     here, and inventing it for a zero-dependency CLI would be ceremony.
#
set -euo pipefail
cd "$(dirname "$0")/.."

STATE_FILE=".release-state.json"
CHANGELOG="CHANGELOG.md"
TOTAL_STEPS=7

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
confirm() {
  local reply
  echo -en "${CYAN}${BOLD}>>>${RESET} $1 ${DIM}[y/N]${RESET} "
  read -r reply
  [[ "$reply" =~ ^[Yy] ]]
}

# --- State ------------------------------------------------------------------
init_state()  { [[ -f "$STATE_FILE" ]] || echo '{}' > "$STATE_FILE"; }
get_state()   { node -e "
  const s=JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8'));
  process.stdout.write(s[process.argv[1]]||'');" "$1" 2>/dev/null || echo ""; }
set_state()   { node -e "
  const fs=require('fs');
  const s=JSON.parse(fs.readFileSync('$STATE_FILE','utf8'));
  s[process.argv[1]]=process.argv[2];
  fs.writeFileSync('$STATE_FILE', JSON.stringify(s,null,2));" "$1" "$2"; }
get_step()      { get_state "_step"; }
set_step()      { set_state "_step" "$1"; }
past_step()     { local c; c=$(get_step); [[ -n "$c" ]] && [[ "$c" -gt "$1" ]]; }
cleanup_state() { rm -f "$STATE_FILE"; }

resolve_editor() {
  [[ -n "${EDITOR:-}" ]] && { echo "$EDITOR"; return; }
  [[ -n "${VISUAL:-}" ]] && { echo "$VISUAL"; return; }
  for c in nano vim vi; do command -v "$c" &>/dev/null && { echo "$c"; return; }; done
  echo ""
}

# Anchor for the release-notes range.
#
# Stable anchors at the last stable tag, so notes cover everything since the
# previous release rather than only since the most recent beta. Beta anchors at
# whatever came last — betas are incremental and should not repeat bullets an
# earlier beta already carried.
last_release_tag() {
  if [[ "$BETA_MODE" == "true" ]]; then
    git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo ""
  else
    git describe --tags --abbrev=0 --match 'v*' --exclude='*-beta.*' 2>/dev/null || echo ""
  fi
}

# --- Preflight --------------------------------------------------------------
preflight() {
  info "Pre-flight..."
  [[ -f package.json ]] || { error "No package.json — run from the project root."; exit 1; }
  command -v node >/dev/null || { error "node is required."; exit 1; }

  if [[ -n "$(git status --porcelain)" ]]; then
    warn "Working tree is not clean:"
    git status --short
    confirm "Continue anyway?" || exit 1
  fi

  # A sanity check, not a functional requirement: CI holds the publish
  # credential. Being signed in as someone who owns the package is still worth
  # confirming before you cut a tag, because that is who can yank it.
  if npm whoami >/dev/null 2>&1; then
    success "npm: logged in as ${BOLD}$(npm whoami)${RESET}"
  else
    warn "Not logged in to npm. CI does the publishing, so this won't block the"
    warn "release — but you won't be able to yank or re-tag it by hand."
    confirm "Continue anyway?" || exit 1
  fi

  local branch; branch=$(git branch --show-current)
  if [[ "$branch" != "main" && "$branch" != "master" ]]; then
    warn "On branch '${branch}', not main/master."
    confirm "Continue anyway?" || exit 1
  fi

  # Without this the beta-number increment and the notes anchor both work off a
  # stale local tag list: the former reuses a tag the remote already has (push
  # rejected), the latter repeats already-shipped bullets.
  info "Fetching tags from origin..."
  git fetch --tags --prune origin 2>/dev/null || warn "git fetch failed — using the local tag list."

  success "Pre-flight OK (branch=${branch})"
}

# --- Release notes ----------------------------------------------------------
step_release_notes() {
  local prev; prev=$(get_state "release_notes")
  if [[ -n "$prev" ]]; then
    info "Using saved release notes."
    return
  fi

  local anchor; anchor=$(last_release_tag)
  local range="HEAD"
  [[ -n "$anchor" ]] && range="${anchor}..HEAD"
  info "Drafting notes from ${BOLD}${range}${RESET}"

  local tmp; tmp=$(mktemp -t pwc-notes)
  {
    git log --no-merges --pretty=format:'- %s' "$range" 2>/dev/null || true
    echo ""
    echo ""
    echo "# Lines starting with # are ignored."
    echo "# Edit the bullets above into user-facing release notes, then save."
  } > "$tmp"

  local editor; editor=$(resolve_editor)
  if [[ -z "$editor" ]]; then
    warn "No \$EDITOR found — using the raw git log as the notes."
  else
    "$editor" "$tmp"
  fi

  local notes; notes=$(grep -v '^#' "$tmp" | sed -e '/./,$!d' || true)
  rm -f "$tmp"
  if [[ -z "${notes//[[:space:]]/}" ]]; then
    error "Release notes are empty."
    exit 1
  fi

  echo ""
  echo -e "${DIM}$(printf '%s\n' "$notes" | sed 's/^/  /')${RESET}"
  echo ""
  confirm "Use these notes?" || { error "Aborted."; exit 1; }
  set_state "release_notes" "$notes"
}

# --- Version ----------------------------------------------------------------
step_version() {
  local current; current=$(node -p "require('./package.json').version")
  info "Current version: ${BOLD}${current}${RESET}"

  local major minor patch
  IFS='.' read -r major minor patch <<< "$current"
  local next_patch="${major}.${minor}.$((patch + 1))"
  local next_minor="${major}.$((minor + 1)).0"
  local next_major="$((major + 1)).0.0"

  # "Keep" is a real option: package.json's version is the *upcoming* release
  # until a v{ver} tag exists for it.
  local keep_note="(no change)"
  git rev-parse "v${current}" >/dev/null 2>&1 && keep_note="${YELLOW}already tagged — pick a bump${RESET}"

  echo ""
  echo -e "    ${DIM}Enter)${RESET} keep   ${BOLD}${current}${RESET} ${DIM}${keep_note}${RESET}"
  echo -e "    ${DIM}1)${RESET}     patch  ${BOLD}${next_patch}${RESET}"
  echo -e "    ${DIM}2)${RESET}     minor  ${BOLD}${next_minor}${RESET}"
  echo -e "    ${DIM}3)${RESET}     major  ${BOLD}${next_major}${RESET}"
  echo -e "    ${DIM}4)${RESET}     custom"
  echo ""
  echo -en "${CYAN}${BOLD}>>>${RESET} Choose version ${DIM}[Enter/1/2/3/4]${RESET} "
  local choice; read -r choice
  case "$choice" in
    "") VERSION="$current" ;;
    1)  VERSION="$next_patch" ;;
    2)  VERSION="$next_minor" ;;
    3)  VERSION="$next_major" ;;
    4)  echo -en "${CYAN}${BOLD}>>>${RESET} Enter version: "; read -r VERSION ;;
    *)  error "Invalid choice"; exit 1 ;;
  esac

  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    error "Version must be X.Y.Z (got '$VERSION'). Prerelease suffixes go on the tag."
    exit 1
  }
  if [[ "$BETA_MODE" != "true" ]] && git rev-parse "v${VERSION}" >/dev/null 2>&1; then
    error "v${VERSION} already exists. A stable version cannot be released twice."
    exit 1
  fi
  set_state "version" "$VERSION"
}

# --- Tag name ---------------------------------------------------------------
#
# Emits "<tag>\t<changelog heading>". Beta picks the next free number so a
# re-run after a failed push does not collide.
resolve_tag() {
  local version; version=$(get_state "version")
  if [[ "$BETA_MODE" != "true" ]]; then
    printf '%s\t%s\n' "v${version}" "${version}"
    return
  fi
  local n=1
  while git rev-parse "v${version}-beta.${n}" >/dev/null 2>&1; do n=$((n + 1)); done
  printf '%s\t%s\n' "v${version}-beta.${n}" "${version}-beta.${n}"
}

# --- Version file + changelog ------------------------------------------------
step_update_version() {
  local version; version=$(get_state "version")
  info "Writing version ${BOLD}${version}${RESET}..."
  # --allow-same-version because "keep" is a legitimate choice above.
  npm version "$version" --no-git-tag-version --allow-same-version > /dev/null
  success "package.json + package-lock.json updated"
}

step_update_changelog() {
  local notes label date
  notes=$(get_state "release_notes")
  label=$(resolve_tag | cut -f2)
  date=$(date +%Y-%m-%d)

  [[ -f "$CHANGELOG" ]] || printf '# Changelog\n\n' > "$CHANGELOG"

  local tmp; tmp=$(mktemp -t pwc-changelog)
  {
    head -n 1 "$CHANGELOG"
    printf '\n## %s — %s\n\n' "$label" "$date"
    printf '%s\n' "$notes"
    tail -n +2 "$CHANGELOG"
  } > "$tmp"
  mv "$tmp" "$CHANGELOG"
  success "${CHANGELOG} updated (## ${label})"
}

# --- Gates ------------------------------------------------------------------
step_checks() {
  info "Running gates (lint, typecheck, unit + E2E)..."
  # Run separately so the failure message names the gate that failed. Note `!`
  # binds to a single command, so `! a && b` would NOT mean "not (a and b)".
  local gate
  for gate in "npm run lint" "npm run typecheck" "npm test"; do
    info "  ${DIM}${gate}${RESET}"
    if ! $gate; then
      error "Gate failed: ${gate}"
      error "Fix it, then re-run — progress is saved in ${STATE_FILE}."
      exit 2
    fi
  done
  success "Gates passed"
}

# --- Commit, tag, push ------------------------------------------------------
step_commit() {
  local version; version=$(get_state "version")
  info "Committing the version bump..."
  git add package.json package-lock.json "$CHANGELOG" 2>/dev/null || true
  if git diff --cached --quiet; then
    warn "Nothing to commit (files already current)."
    return
  fi
  git commit -m "release: v${version}"
  success "Committed"
}

step_tag_and_push() {
  local notes tag
  notes=$(get_state "release_notes")
  tag=$(resolve_tag | cut -f1)

  info "Tagging ${BOLD}${tag}${RESET}..."
  printf '%s\n' "$notes" | git tag -a "$tag" -F -

  info "Pushing..."
  git push || { error "git push failed. Tag exists locally: git tag -d ${tag}"; exit 3; }
  git push origin "$tag" || {
    error "Tag push failed. Retry: git push origin ${tag}"
    error "Unwind:              git tag -d ${tag}"
    exit 3
  }

  success "${tag} pushed."
  echo ""
  if [[ "$BETA_MODE" == "true" ]]; then
    echo -e "  ${DIM}CI (release.yml) will:${RESET}"
    echo -e "    1. Re-run lint, typecheck, unit + E2E"
    echo -e "    2. Publish ${BOLD}pueue-wait-cond@${tag#v}${RESET} under the ${BOLD}beta${RESET} dist-tag"
    echo -e "    3. Create a GitHub ${BOLD}prerelease${RESET} for ${tag}"
    echo ""
    echo -e "  ${DIM}Betas stay opt-in: 'latest' keeps pointing at the previous stable.${RESET}"
    echo -e "  ${DIM}Install with: npm i pueue-wait-cond@beta${RESET}"
  else
    echo -e "  ${DIM}CI (release.yml) will:${RESET}"
    echo -e "    1. Re-run lint, typecheck, unit + E2E"
    echo -e "    2. Publish ${BOLD}pueue-wait-cond@${tag#v}${RESET} under ${BOLD}latest${RESET}, with provenance"
    echo -e "    3. Create a GitHub Release for ${tag}"
  fi
  echo ""
  echo -e "  ${DIM}Monitor:${RESET} https://github.com/brianwestphal/pueue-wait-cond/actions"
  echo -e "  ${DIM}Unwind before CI finishes:${RESET}"
  echo -e "    git push origin :refs/tags/${tag} && git tag -d ${tag}"
}

# --- Main -------------------------------------------------------------------
BETA_MODE=false
for arg in "$@"; do
  case "$arg" in
    --beta) BETA_MODE=true ;;
    -h|--help)
      echo "Usage: bash scripts/release.sh [--beta]"
      echo "  (no flag)  stable release: bump version, changelog, commit, tag v{ver}"
      echo "  --beta     beta release:   same, but tag v{ver}-beta.N"
      exit 0 ;;
    *) error "Unrecognized arg: $arg"; exit 1 ;;
  esac
done

echo ""
if [[ "$BETA_MODE" == "true" ]]; then
  echo -e "${BOLD}  pueue-wait-cond — Beta Release${RESET}"
  echo -e "  ${DIM}Publishes under the 'beta' dist-tag. 'latest' is untouched.${RESET}"
else
  echo -e "${BOLD}  pueue-wait-cond — Release${RESET}"
fi
echo ""

init_state
resume=$(get_step)
if [[ -n "$resume" && "$resume" -gt 0 ]]; then
  warn "Found saved progress (step ${resume}/${TOTAL_STEPS})."
  if confirm "Resume?"; then echo ""
  elif confirm "Start over?"; then cleanup_state; init_state
  else exit 0; fi
fi

past_step 1 || { preflight;             set_step 1; }
past_step 2 || { step_release_notes;    set_step 2; }
past_step 3 || { echo ""; step_version; set_step 3; }

if ! past_step 4; then
  version=$(get_state "version"); notes=$(get_state "release_notes")
  echo ""
  echo -e "${BOLD}━━━ Release Summary ━━━${RESET}"
  echo ""
  echo -e "  ${DIM}Channel:${RESET} $([[ "$BETA_MODE" == "true" ]] && echo "beta" || echo "stable")"
  echo -e "  ${DIM}Version:${RESET} ${BOLD}${version}${RESET}"
  echo -e "  ${DIM}Tag:${RESET}     ${BOLD}$(resolve_tag | cut -f1)${RESET}"
  echo -e "  ${DIM}Notes:${RESET}"
  printf '%s\n' "$notes" | sed 's/^/    /'
  echo ""
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""
  confirm "Proceed?" || { warn "Aborted. State saved — run again to resume."; exit 0; }
  set_step 4
fi

past_step 5 || { echo ""; step_update_version; step_update_changelog; set_step 5; }
past_step 6 || { echo ""; step_checks;                                set_step 6; }
past_step 7 || { echo ""; step_commit; step_tag_and_push;             set_step 7; }

cleanup_state
echo ""
success "Done."
