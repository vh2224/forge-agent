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

# The PATH exactly as the caller handed it over, captured BEFORE the floor below
# is appended. Rung 2 of the search probes THIS, never the floored PATH: a hit in
# a directory we ourselves added is not evidence about the caller's environment,
# and reading it as such suppresses the PATH repair on any system that ships
# /usr/bin/node — which is the second failure mode (`capability obrigatória
# ausente para claude`) coming straight back. Measured on the Linux CI runner.
FORGE_INHERITED_PATH="${PATH:-}"

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

# The fixed-path candidate list, one per line. Split on ':' when the seam is set,
# so a caller can express an empty search without an empty-string candidate.
forge_fixed_candidates() {
  if [ -n "${FORGE_NODE_FIXED_CANDIDATES:-}" ]; then
    printf '%s\n' "${FORGE_NODE_FIXED_CANDIDATES}" | tr ':' '\n'
    return 0
  fi
  printf '%s\n' \
    /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node \
    "${HOME}/.volta/bin/node" \
    "${HOME}/.asdf/shims/node" \
    "${HOME}/.local/share/mise/shims/node" \
    "${HOME}/.local/share/fnm/aliases/default/bin/node" \
    "${HOME}/.fnm/aliases/default/bin/node"
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

  # 2. Whatever the CALLER's PATH already has — free, and correct in a terminal.
  #    A hit here is also the evidence that the inherited PATH is the operator's
  #    own, which is why it must not see the floor this script appends.
  found="$(PATH="${FORGE_INHERITED_PATH}" command -v node 2>/dev/null || true)"
  if [ -n "${found}" ]; then FORGE_NODE="${found}"; FORGE_NODE_SOURCE="path"; return 0; fi

  # 3. Fixed installs, then the shim each version manager publishes at a stable
  #    path. Nothing here hardcodes a version number.
  #
  #    FORGE_NODE_FIXED_CANDIDATES (colon-separated) replaces this list. It is a
  #    TEST SEAM, in the same family as FORGE_XLLM_AGY_BIN and
  #    FORGE_NEW_WINDOW_DRYRUN elsewhere in this repo, and it exists because
  #    without it the rungs below are unreachable on any machine that ships node
  #    at a fixed path — every CI runner does. A test that cannot reach the rung
  #    it names does not fail there: it reports green having measured nothing,
  #    which is the one outcome worth more than the seam costs.
  while IFS= read -r candidate; do
    [ -n "${candidate}" ] || continue
    if [ -x "${candidate}" ]; then
      FORGE_NODE="${candidate}"; FORGE_NODE_SOURCE="fixed"; return 0
    fi
  done <<EOF
$(forge_fixed_candidates)
EOF

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
    echo "  • caminhos fixos e shims procurados:"
    forge_fixed_candidates | while IFS= read -r c; do echo "      ${c}"; done
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

# `--update` no longer means "reinstall this clone": it routes to the updater,
# whose default source is the server. The flag is consumed here rather than
# forwarded, because the two Node entry points disagree about it — the installer
# takes `--update`, the updater takes `--apply`/`--dry-run`.
UPDATE=false
FORWARDED=()
for arg in "$@"; do
  if [[ "$arg" == "--update" ]]; then
    UPDATE=true
  else
    FORWARDED+=("$arg")
  fi
done

# `"${FORWARDED[@]}"` on an EMPTY array is an "unbound variable" error under
# `set -u` in bash 3.2 — which is still /bin/bash on macOS, a platform this
# installer supports by contract. The previous wrapper forwarded `"$@"`, a
# special parameter that is always safe when empty, so introducing the array
# introduced the hazard. `${FORWARDED[@]+...}` expands to nothing at all when the
# array is empty and is a no-op everywhere else. Not reproduced on this machine
# (bash 5.2 only); this is the documented 3.2 behaviour, guarded rather than
# waited for.
#
# Both execs use ${FORGE_NODE}, never a bare `node`: the interpreter resolved
# above is the whole reason this bootstrap exists, and an update launched from a
# GUI would exit 127 without it.
if [[ "$UPDATE" == "true" ]]; then
  HAS_DRY_RUN=false
  for arg in ${FORWARDED[@]+"${FORWARDED[@]}"}; do
    [[ "$arg" == "--dry-run" ]] && HAS_DRY_RUN=true
  done
  [[ "$HAS_DRY_RUN" == "true" ]] || FORWARDED+=("--apply")
  exec "${FORGE_NODE}" "${REPO_DIR}/scripts/forge-update.js" ${FORWARDED[@]+"${FORWARDED[@]}"}
fi

exec "${FORGE_NODE}" "${REPO_DIR}/scripts/forge-installer.js" --repo "${REPO_DIR}" ${FORWARDED[@]+"${FORWARDED[@]}"}
