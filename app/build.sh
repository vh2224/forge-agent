#!/usr/bin/env bash
# build.sh — compile the Forge menu bar app into a real .app bundle.
#
# No Xcode project: swiftc plus a hand-rolled bundle is enough for a menu-bar
# app, so the build works anywhere the Command Line Tools are installed.
#
#   ./app/build.sh              build into app/build/Forge.app
#   ./app/build.sh --install    also copy it into /Applications
#   ./app/build.sh --run        also launch it
#   ./app/build.sh --debug      assemble the bundle from the DEBUG binary
#
# --debug composes freely with --run and --install; it changes only which
# binary gets packaged, never where the bundle goes. It exists because a real
# bundle is the only way to run this app at all: `swift run Forge` dies inside
# Notifier.shared's init, where UNUserNotificationCenter needs a bundle and
# throws "bundleProxyForCurrentProcess is nil". On a machine without Xcode the
# canvas is unavailable too, which leaves this script as the whole loop.
#
# Costs, measured on this machine:
#   --debug     ~10s, because an incremental `swift build` is sub-second and the
#               rest is icon, plist and codesign. Use it to judge FORM.
#   (release)   minutes. This is the loop that proves the stamped version (D25)
#               and final fidelity; a debug bundle never substitutes for it.
#
# Both configurations stamp the bundle's Info.plist with the git describe
# (CFBundleShortVersionString, CFBundleVersion, ForgeGitDescribe) so the sidebar
# footer reports the version actually running. The versioned app/Info.plist is
# never touched.
#
# The other loop, when Xcode exists: the canvas. Open app/Package.swift in
# Xcode, then app/Sources/Forge/Previews.swift, and press ⌥⌘↩ — sub-second.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${APP_DIR}/build"
BUNDLE="${BUILD_DIR}/Forge.app"

DO_INSTALL=false
DO_RUN=false
DO_DEBUG=false
for arg in "$@"; do
  case "$arg" in
    --install) DO_INSTALL=true ;;
    --run)     DO_RUN=true ;;
    --debug)   DO_DEBUG=true ;;
    -h|--help)
      sed -n '2,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "build.sh: opção desconhecida: $arg" >&2; exit 2 ;;
  esac
done

if ! command -v swiftc >/dev/null 2>&1; then
  echo "build.sh: swiftc não encontrado. Instale as Command Line Tools:" >&2
  echo "  xcode-select --install" >&2
  exit 1
fi

echo "▸ Limpando build anterior"
rm -rf "$BUNDLE"
mkdir -p "${BUNDLE}/Contents/MacOS" "${BUNDLE}/Contents/Resources"

# SPM rather than a bare swiftc invocation: the terminal needs SwiftTerm's VT
# emulator as a dependency. First build downloads it; later builds are cached.
#
# `-c debug` is spelled out rather than left as an empty array: this script runs
# under `set -u`, and expanding an empty array trips it on the bash 3.2 that
# ships with macOS.
if $DO_DEBUG; then
  SWIFT_ARGS=(-c debug)
  CONFIG_LABEL="debug"
else
  SWIFT_ARGS=(-c release --arch arm64)
  CONFIG_LABEL="release, arm64"
fi

echo "▸ Compilando (swift build ${CONFIG_LABEL}, SwiftTerm)"
( cd "$APP_DIR" && swift build "${SWIFT_ARGS[@]}" ) || exit 1
BIN="$(cd "$APP_DIR" && swift build "${SWIFT_ARGS[@]}" --show-bin-path)/Forge"
if [ ! -f "$BIN" ]; then
  echo "build.sh: binário não encontrado em $BIN" >&2
  exit 1
fi
cp "$BIN" "${BUNDLE}/Contents/MacOS/Forge"

# ── SwiftPM resource bundles ──────────────────────────────────────────────────
# Copying only the binary was enough until ForgeKit declared `resources:`. It is
# not any more, and the gap is INVISIBLE: `Bundle.module` resolves next to the
# executable under `swift run`, so every test passes, and the assembled .app —
# whose executable sits in Contents/MacOS with no bundle beside it — finds
# nothing and draws blank. Contents/Resources is where SwiftPM's generated
# accessor looks second (Bundle.main.resourceURL), which is why this is the
# destination and not Contents/MacOS.
#
# The glob is guarded by a `compgen` test rather than left bare: under `set -u`
# with `nullglob` unset, an unmatched glob expands to the literal pattern and
# `cp` would fail the build on a configuration that legitimately has no bundles.
BIN_DIR="$(dirname "$BIN")"
if compgen -G "${BIN_DIR}/"'*.bundle' >/dev/null; then
  echo "▸ Copiando bundles de recursos (ícones vendorizados)"
  cp -R "${BIN_DIR}/"*.bundle "${BUNDLE}/Contents/Resources/"
else
  echo "  aviso: nenhum *.bundle em ${BIN_DIR} — marcas vendorizadas cairão no SF Symbol"
fi

ICON="${APP_DIR}/Forge.icns"
if [ ! -f "$ICON" ]; then
  echo "▸ Gerando ícone"
  ( cd "$APP_DIR" && swift run -c release ForgeIcon "$ICON" ) \
    || echo "  aviso: ícone não gerado — o app usa o genérico"
fi
if [ -f "$ICON" ]; then
  cp "$ICON" "${BUNDLE}/Contents/Resources/Forge.icns"
fi

cp "${APP_DIR}/Info.plist" "${BUNDLE}/Contents/Info.plist"

# ── Stamp the version into the bundle (D25) ───────────────────────────────────
# Position is load-bearing in BOTH directions, and neither is obvious:
#
#   * AFTER the cp above: stamping before it would edit the versioned
#     app/Info.plist (R8). The operator develops in this repo, and the in-app
#     updater refuses to run on a dirty tree, so a build that dirtied the tree
#     could block the very update path this stamp exists to serve.
#   * BEFORE the codesign below: the signature covers Info.plist. Stamping a
#     signed bundle turns `codesign --verify` from "valid on disk" into
#     "invalid Info.plist (plist or signature have been modified)" — probed, not
#     assumed. A JS guard (scripts/forge-app-sidebar.test.js) pins this ordering
#     because it is invisible at runtime: an out-of-order stamp still produces a
#     bundle that looks right and launches.
#
# `plutil -replace` rather than `PlistBuddy -c "Set …"`: Set on an absent key
# exits 1, which under `set -euo pipefail` would kill the build; -replace creates
# the key and exits 0. Both ship with stock macOS.
#
# Not moved below `if $DO_INSTALL` "to catch both copies": --install copies the
# already-signed, already-stamped bundle, so there is only ever one copy to
# stamp — and stamping after the copy would leave both signatures invalid.
GIT_DESCRIBE="$( cd "$APP_DIR" && git describe --tags 2>/dev/null || true )"
# Apple wants CFBundleShortVersionString as dot-separated integers only, so the
# tag is reduced to its numeric prefix: v3.3.0 → 3.3.0, v3.0.0-beta → 3.0.0.
SHORT_VERSION="$( printf '%s' "$GIT_DESCRIBE" | sed 's/^v//; s/-.*$//; s/[^0-9.]//g' )"
BUILD_NUMBER="$( cd "$APP_DIR" && git rev-list --count HEAD 2>/dev/null || true )"

if [ -n "$GIT_DESCRIBE" ]; then
  echo "▸ Estampando versão (${GIT_DESCRIBE})"
  plutil -replace ForgeGitDescribe -string "$GIT_DESCRIBE" "${BUNDLE}/Contents/Info.plist"
  # if/then, never `[ -n "$x" ] && plutil …`: a bare `test && cmd` statement whose
  # test is false makes the statement itself exit 1, and `set -e` would abort the
  # build on the very fallback path this guard exists to survive.
  if [ -n "$SHORT_VERSION" ]; then
    plutil -replace CFBundleShortVersionString -string "$SHORT_VERSION" "${BUNDLE}/Contents/Info.plist"
  fi
  if [ -n "$BUILD_NUMBER" ]; then
    plutil -replace CFBundleVersion -string "$BUILD_NUMBER" "${BUNDLE}/Contents/Info.plist"
  fi
else
  # Outside a git clone (tarball, no tags) there is nothing truthful to stamp.
  # The build must still work, so this is a warning, not an error — and the keys
  # are left alone rather than blanked: the footer's sentinel is the ABSENCE of
  # ForgeGitDescribe, so an unstamped bundle reports itself honestly as unknown,
  # whereas an empty-but-present key would read as a stamped build with no name.
  echo "  aviso: git describe indisponível — bundle não estampado (o rodapé dirá 'versão desconhecida')"
fi

echo "▸ Assinando (ad-hoc)"
# Ad-hoc signature: enough for the app to run locally. A Developer ID would be
# needed only to distribute it to another machine without Gatekeeper warnings.
codesign --force --sign - --timestamp=none "$BUNDLE" >/dev/null 2>&1 \
  || echo "  aviso: codesign falhou — o app ainda roda localmente"

echo "✓ ${BUNDLE}"

if $DO_INSTALL; then
  echo "▸ Instalando em /Applications"
  rm -rf "/Applications/Forge.app"
  cp -R "$BUNDLE" "/Applications/Forge.app"
  echo "✓ /Applications/Forge.app"
  BUNDLE="/Applications/Forge.app"
fi

if $DO_RUN; then
  echo "▸ Abrindo"
  pkill -x Forge 2>/dev/null || true
  open "$BUNDLE"
fi
