#!/usr/bin/env bash
# mcpc installer for Linux and macOS.
#
#   ./installer.sh [install [claude|codex|other <SKILLS_DIR>]]
#   ./installer.sh uninstall [claude|codex|other <SKILLS_DIR>]
#   ./installer.sh -h | --help
#
# Piped:
#   curl -fsSL https://github.com/XiaoNetwork-Astral/mcpc/releases/latest/download/installer.sh | bash
#   curl -fsSL https://github.com/XiaoNetwork-Astral/mcpc/releases/latest/download/installer.sh | bash -s -- uninstall
#
# Installing clones the latest release into ~/.mcpc/app, or upgrades the
# checkout found there or next to this script, and hands over to
# scripts/installer.mjs. Uninstalling needs no checkout, so it also cleans up
# after a broken install. MCPC_INSTALL_REPO overrides the repository to clone.
set -eu

repo_url="${MCPC_INSTALL_REPO:-https://github.com/XiaoNetwork-Astral/mcpc.git}"
state_dir="${HOME:?HOME is not set}/.mcpc"
app_dir="$state_dir/app"
record="$state_dir/installed-skills.txt"
usage_line='Usage: installer [install|uninstall] [claude|codex|other <SKILLS_DIR>]'

ok() { printf '  \342\234\223 %s%s\n' "$1" "${2:+  $2}"; }
warn() { printf '  ! %s%s\n' "$1" "${2:+  $2}"; }
fail() {
  printf '  \342\234\227 %s\n' "$1" >&2
  if [ -n "${2:-}" ]; then printf '    -> %s\n' "$2" >&2; fi
  exit 1
}

usage() {
  cat <<'EOF'
mcpc installer (Linux and macOS)

Usage:
  installer [install [claude|codex|other <SKILLS_DIR>]]
  installer uninstall [claude|codex|other <SKILLS_DIR>]
  installer -h | --help

install    Install mcpc into ~/.mcpc/app, or upgrade it to the latest release,
           link the mcpc command, and copy the mcp-client skill into every
           harness found (with a harness named, into that one as well).
uninstall  Remove the skill from every harness it was copied to, the mcpc
           command and ~/.mcpc/app. Configuration, caches and logs in ~/.mcpc
           stay. With a harness named, remove only that copy of the skill.

Harnesses:
  claude   ~/.claude/skills (found when ~/.claude exists)
  codex    ~/.agents/skills (found when ~/.agents or ~/.codex exists)
  other    any absolute skills directory

After installing, mcpc update upgrades to the latest release.
EOF
}

# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------

action='install'
case "${1:-}" in
  install | uninstall)
    action="$1"
    shift
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  '') ;;
  *) fail "Unknown command: $1" "$usage_line" ;;
esac

skills_dir=''
if [ $# -gt 0 ]; then
  case "$1" in
    claude) skills_dir="$HOME/.claude/skills" ;;
    codex) skills_dir="$HOME/.agents/skills" ;;
    other)
      if [ $# -lt 2 ] || [ -z "$2" ]; then fail 'other needs an absolute skills directory' "$usage_line"; fi
      case "$2" in
        /* | [A-Za-z]:[\\/]*) ;;
        *) fail "The skills directory must be absolute: $2" "$usage_line" ;;
      esac
      skills_dir="${2%/}"
      shift
      ;;
    *) fail "Unknown harness: $1" "$usage_line" ;;
  esac
  shift
fi
if [ $# -gt 0 ]; then fail "Unexpected argument: $1" "$usage_line"; fi

is_checkout() {
  [ -f "$1/package.json" ] && [ -f "$1/scripts/installer.mjs" ] &&
    grep -q '"name": "mcpc"' "$1/package.json"
}

is_skill() {
  [ -f "$1/SKILL.md" ] && grep -Eq '^name:[[:space:]]*mcp-client[[:space:]]*$' "$1/SKILL.md"
}

# ---------------------------------------------------------------------------
# Install or upgrade
# ---------------------------------------------------------------------------

install() {
  printf 'mcpc installer\n'
  if ! command -v git >/dev/null 2>&1; then
    fail 'Git is required' 'Install Git from https://git-scm.com/downloads, then reopen the terminal'
  fi
  ok "$(git --version)"
  if ! command -v node >/dev/null 2>&1; then
    fail 'Node.js 24.9 or newer is required' 'Install the current Node.js LTS from https://nodejs.org, then reopen the terminal'
  fi
  if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 24 || (a === 24 && b >= 9) ? 0 : 1)'; then
    fail "Node.js 24.9 or newer is required; found $(node --version)" 'Install the current Node.js LTS from https://nodejs.org, then reopen the terminal'
  fi
  ok "Node.js $(node --version)"
  if ! command -v npm >/dev/null 2>&1; then
    fail 'npm is required' 'Reinstall Node.js with npm from https://nodejs.org, then reopen the terminal'
  fi
  ok "npm $(npm --version)"

  checkout=''
  script_source="${BASH_SOURCE[0]:-}"
  if [ -n "$script_source" ] && [ -f "$script_source" ]; then
    script_dir="$(cd -P -- "$(dirname -- "$script_source")" && pwd)"
    if is_checkout "$script_dir"; then checkout="$script_dir"; fi
  fi
  if [ -z "$checkout" ] && is_checkout "$app_dir"; then checkout="$app_dir"; fi

  if [ -n "$checkout" ]; then
    ok 'Found mcpc' "$checkout"
  else
    if [ -e "$app_dir" ] && [ -n "$(ls -A "$app_dir" 2>/dev/null || true)" ]; then
      fail "$app_dir exists but is not an mcpc checkout" 'Move or remove it, then run the installer again'
    fi
    tag="$(git ls-remote --tags --refs --sort=-v:refname "$repo_url" </dev/null 2>/dev/null |
      sed -n 's#.*refs/tags/##p' | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)"
    if [ -z "$tag" ]; then
      fail 'Cannot find the latest mcpc release' "Check network access: git ls-remote --tags $repo_url"
    fi
    mkdir -p "$state_dir"
    if ! git -c advice.detachedHead=false clone --quiet --branch "$tag" "$repo_url" "$app_dir" </dev/null; then
      fail "Cannot clone mcpc $tag" "git clone --branch $tag $repo_url \"$app_dir\""
    fi
    ok "Cloned mcpc $tag" "$app_dir"
    checkout="$app_dir"
  fi

  if [ -n "$skills_dir" ]; then
    node "$checkout/scripts/installer.mjs" install --skills "$skills_dir"
  else
    node "$checkout/scripts/installer.mjs" install
  fi
  ok 'mcpc is installed' 'run mcpc --help to start, mcpc update to upgrade'
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------

remove_skill() {
  if is_skill "$1"; then
    rm -rf -- "$1"
    ok 'Removed the mcp-client skill' "$1"
  elif [ -e "$1" ]; then
    warn 'Not the mcp-client skill; left it in place' "$1"
  fi
}

uninstall() {
  printf 'mcpc uninstaller\n'
  if [ -n "$skills_dir" ]; then
    if [ -e "$skills_dir/mcp-client" ]; then
      remove_skill "$skills_dir/mcp-client"
    else
      ok "No mcp-client skill in $skills_dir"
    fi
    if [ -f "$record" ]; then
      grep -vxF -e "$skills_dir/mcp-client" -e "$skills_dir\\mcp-client" "$record" >"$record.tmp" || true
      mv -f -- "$record.tmp" "$record"
    fi
    return 0
  fi

  entries=("$HOME/.claude/skills/mcp-client" "$HOME/.agents/skills/mcp-client")
  if [ -f "$record" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%$'\r'}"
      if [ -n "$line" ]; then entries+=("$line"); fi
    done <"$record"
  fi
  for entry in "${entries[@]}"; do remove_skill "$entry"; done

  if command -v npm >/dev/null 2>&1; then
    if npm ls --global --depth=0 mcpc >/dev/null 2>&1; then
      if npm uninstall --global mcpc >/dev/null 2>&1; then
        ok 'Removed the mcpc command'
      else
        warn 'Cannot remove the mcpc command' 'npm uninstall -g mcpc'
      fi
    fi
  else
    warn 'npm was not found, so the mcpc command was not checked'
  fi

  if is_checkout "$app_dir"; then
    rm -rf -- "$app_dir"
    ok 'Removed the checkout' "$app_dir"
  fi
  rm -f -- "$record"
  ok 'mcpc is uninstalled' "configuration, caches and logs stay in $state_dir"
}

if [ "$action" = uninstall ]; then uninstall; else install; fi
