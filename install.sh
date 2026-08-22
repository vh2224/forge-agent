#!/usr/bin/env bash
# Forge Agent installer wrapper for macOS/Linux and Git Bash. The Node core
# owns all filesystem semantics; this wrapper only forwards argv — plus the one
# thing it cannot delegate, because it has to happen before the core runs:
# handing it an environment where its tools exist.
#
# Why that is not `exec node`: a GUI launcher inherits launchd's minimal
# environment (PATH=/usr/bin:/bin:/usr/sbin:/sbin), which cannot contain a
# version-managed node. The Forge app's update buttons spawn this script through
# `bash -lc`, and a login bash does not read ~/.zshrc — where nvm/fnm install
# themselves on most machines. `exec node` there exits 127 and the app reported
# "a atualização falhou (código 127)" (measured 2026-08-20, app v4.18.0).
#
# Finding node is necessary and NOT sufficient: the core's capability probes
# shell out to `claude`/`codex`, which live wherever the operator's rc puts them
# (~/.local/bin on the machine this was measured on). Under the same minimal
# PATH the install then died one step later with "capability obrigatória
# ausente para claude: claude". So the wrapper repairs the PATH, not just the
# interpreter.
#
# This bootstrap lives HERE, not only in the app, on purpose: an app binary
# already on disk cannot be fixed by a change to itself — it has to run this
# script successfully in order to rebuild. Any caller with a broken environment
# gets the repair, including app versions that predate it.
#
# Interpreter search mirrors app/Sources/ForgeKit/NodeLocator.swift. The two
# cannot share an implementation: both exist to locate the interpreter *before*
# any interpreter of ours is running.
set -euo pipefail

# The wrapper itself needs a handful of standard tools (mktemp, tail, sleep) and
# resolves them through the very PATH it is here to repair. Appended, so nothing
# the caller resolves changes; this only guarantees the floor exists.
PATH="${PATH:-}:/usr/bin:/bin:/usr/sbin:/sbin"; export PATH

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Filled in by forge_resolve_node. These are ASSIGNED, never printed and
# captured: `$(...)` runs in a subshell, so a rung recorded in there would be
# lost on return and the PATH repair below would read an empty source and fire
# unconditionally. (Caught by forge-install-bootstrap.test.js; same shell
# pitfall as auto-mode `started_at` and `$CODE_DIR_HINT` in this repo.)
FORGE_NODE=""
FORGE_NODE_SOURCE=""

# Run a command with a wall-clock bound, so a slow or blocking shell rc cannot
# hang the installer behind a progress bar that never moves. `timeout(1)` is
# absent from stock macOS, hence the background-and-reap fallback.
forge_bounded() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "${secs}" "$@"; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "${secs}" "$@"; return $?; fi
  local out rc pid watcher
  out="$(mktemp)"
  "$@" >"${out}" 2>/dev/null & pid=$!
  ( sleep "${secs}"; kill -TERM "${pid}" ) >/dev/null 2>&1 & watcher=$!
  rc=0; wait "${pid}" 2>/dev/null || rc=$?
  kill "${watcher}" >/dev/null 2>&1 || true
  cat "${out}"; rm -f "${out}"
  return "${rc}"
}

# Sets FORGE_NODE and FORGE_NODE_SOURCE, or writes a diagnosis to stderr and
# returns non-zero. Must be called plainly — never inside `$(...)`.
forge_resolve_node() {
  local candidate found

  # 1. Operator override. A broken override is reported, never routed around —
  #    otherwise there is no way to tell it was ignored.
  if [ -n "${FORGE_NODE_PATH:-}" ]; then
    if [ -x "${FORGE_NODE_PATH}" ]; then
      FORGE_NODE="${FORGE_NODE_PATH}"; FORGE_NODE_SOURCE="override"; return 0
    fi
    echo "install.sh: FORGE_NODE_PATH=${FORGE_NODE_PATH} não é um executável" >&2
    return 1
  fi

  # 2. Whatever PATH already has — free, and correct in a terminal. A hit here
  #    is also the evidence that the inherited PATH is the operator's own.
  found="$(command -v node 2>/dev/null || true)"
  if [ -n "${found}" ]; then FORGE_NODE="${found}"; FORGE_NODE_SOURCE="path"; return 0; fi

  # 3. Fixed installs, then the shim each version manager publishes at a stable
  #    path. Nothing here hardcodes a version number.
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node \
                   "${HOME}/.volta/bin/node" \
                   "${HOME}/.asdf/shims/node" \
                   "${HOME}/.local/share/mise/shims/node" \
                   "${HOME}/.local/share/fnm/aliases/default/bin/node" \
                   "${HOME}/.fnm/aliases/default/bin/node"; do
    if [ -x "${candidate}" ]; then
      FORGE_NODE="${candidate}"; FORGE_NODE_SOURCE="fixed"; return 0
    fi
  done

  # 4. Ask the login+interactive shell. This is what actually resolves nvm,
  #    which publishes no shim at all — its node lives under a version
  #    directory that only its rc snippet puts on PATH. Interactive (-i) as
  #    well as login (-l) because that snippet is usually in ~/.zshrc.
  found="$(forge_login_eval 'command -v node')"
  if [ -n "${found}" ] && [ -x "${found}" ]; then
    FORGE_NODE="${found}"; FORGE_NODE_SOURCE="loginShell"; return 0
  fi

  {
    echo "install.sh: node não encontrado — o instalador do Forge precisa dele."
    echo "Procurei em:"
    echo "  • FORGE_NODE_PATH: não definido"
    echo "  • \$PATH = ${PATH}"
    echo "  • caminhos fixos: /opt/homebrew/bin, /usr/local/bin, /usr/bin"
    echo "  • shims de gerenciador: volta, asdf, mise, fnm"
    echo "  • shell de login (${SHELL:-/bin/sh} -lic 'command -v node')"
    echo "Defina o caminho explicitamente:"
    echo "  FORGE_NODE_PATH=/caminho/para/node ./install.sh $*"
  } >&2
  return 1
}

# One line of stdout from the operator's login+interactive shell, bounded. The
# last line is the answer: an rc file is free to print its own noise first.
forge_login_eval() {
  forge_bounded "${FORGE_LOGIN_TIMEOUT:-8}" "${SHELL:-/bin/sh}" -lic "$1" 2>/dev/null | tail -n 1 || true
}

forge_resolve_node "$@"

# The PATH that could not find node is not the operator's PATH — it is a
# launcher's. Borrow theirs so the core's capability probes can see the CLIs
# the operator actually installed. Appended, never prepended: whatever the
# caller already resolves keeps winning, and this only adds what was missing.
if [ "${FORGE_NODE_SOURCE}" != "path" ]; then
  FORGE_LOGIN_PATH="$(forge_login_eval 'printf "%s\n" "$PATH"')"
  case "${FORGE_LOGIN_PATH}" in
    */*) PATH="${PATH}:${FORGE_LOGIN_PATH}"; export PATH ;;
    *)   echo "install.sh: não consegui ler o PATH do shell de login (${SHELL:-/bin/sh}); seguindo com o PATH herdado" >&2 ;;
  esac
fi

# The interpreter we resolved is the one the core and every child it spawns
# must use — including app/build.sh.
PATH="${FORGE_NODE%/*}:${PATH}"; export PATH

exec "${FORGE_NODE}" "${REPO_DIR}/scripts/forge-installer.js" --repo "${REPO_DIR}" "$@"
