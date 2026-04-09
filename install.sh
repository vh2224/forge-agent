#!/usr/bin/env bash
# GSD Agent — Installer for Claude Code (macOS / Linux / Windows Git Bash)
# Usage: bash install.sh [--update] [--dry-run]

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# On Windows Git Bash, convert /c/DEV/... to C:/DEV/... so the path works in Node.js and Claude Code
if command -v cygpath &>/dev/null; then
  REPO_DIR="$(cygpath -m "$REPO_DIR")"
fi
CLAUDE_DIR="${HOME}/.claude"
BACKUP_DIR="${CLAUDE_DIR}/forge-agent-backup-$(date +%Y%m%d%H%M%S)"
DRY_RUN=false
UPDATE=false

# ── Args ─────────────────────────────────────────────────────────────────────
for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    --update)  UPDATE=true  ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────
info()    { echo "  $1"; }
success() { echo "✓ $1"; }
warn()    { echo "⚠ $1"; }
dry()     { echo "  [dry-run] $1"; }

copy() {
  local src="$1" dst="$2"
  if $DRY_RUN; then
    dry "cp $src → $dst"
  else
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
  fi
}

# ── Detect Claude Code ────────────────────────────────────────────────────────
echo ""
echo "GSD Agent Installer"
echo "════════════════════"
echo ""

if [ ! -d "$CLAUDE_DIR" ]; then
  echo "✗ Claude Code config directory not found at: $CLAUDE_DIR"
  echo "  Install Claude Code first: https://claude.ai/code"
  exit 1
fi
success "Claude Code found at $CLAUDE_DIR"

# ── Backup existing if updating ───────────────────────────────────────────────
AGENTS_DIR="${CLAUDE_DIR}/agents"
COMMANDS_DIR="${CLAUDE_DIR}/commands"

has_existing=false
for f in "${AGENTS_DIR}"/forge*.md "${COMMANDS_DIR}"/forge*.md "${CLAUDE_DIR}/forge-agent-prefs.md"; do
  [ -f "$f" ] && has_existing=true && break
done

if $has_existing && ! $UPDATE; then
  echo ""
  warn "GSD Agent files already exist."
  echo "  Run with --update to overwrite (existing files will be backed up)."
  echo "  Or run: bash install.sh --update"
  exit 0
fi

if $has_existing && $UPDATE; then
  if ! $DRY_RUN; then
    mkdir -p "$BACKUP_DIR/agents" "$BACKUP_DIR/commands"
    for f in "${AGENTS_DIR}"/forge*.md; do [ -f "$f" ] && cp "$f" "$BACKUP_DIR/agents/"; done
    for f in "${COMMANDS_DIR}"/forge*.md; do [ -f "$f" ] && cp "$f" "$BACKUP_DIR/commands/"; done
    [ -f "${CLAUDE_DIR}/forge-agent-prefs.md" ] && cp "${CLAUDE_DIR}/forge-agent-prefs.md" "$BACKUP_DIR/"
    [ -f "${CLAUDE_DIR}/forge-statusline.js"  ] && cp "${CLAUDE_DIR}/forge-statusline.js"  "$BACKUP_DIR/"
    [ -f "${CLAUDE_DIR}/forge-hook.js"        ] && cp "${CLAUDE_DIR}/forge-hook.js"         "$BACKUP_DIR/"
    [ -f "${CLAUDE_DIR}/forge-settings.js"   ] && cp "${CLAUDE_DIR}/forge-settings.js"    "$BACKUP_DIR/"
  fi
  success "Backup saved to $BACKUP_DIR"
fi

# ── Clean up legacy gsd-* files ──────────────────────────────────────────────
echo ""
info "Cleaning up legacy gsd-* files..."
cleaned=0
for f in "${AGENTS_DIR}"/gsd-*.md; do
  [ -f "$f" ] || continue
  if $DRY_RUN; then
    dry "rm $f"
  else
    rm "$f"
  fi
  info "  removed agents/$(basename "$f")"
  cleaned=$((cleaned + 1))
done
for f in "${COMMANDS_DIR}"/gsd-*.md; do
  [ -f "$f" ] || continue
  if $DRY_RUN; then
    dry "rm $f"
  else
    rm "$f"
  fi
  info "  removed commands/$(basename "$f")"
  cleaned=$((cleaned + 1))
done
if [ "$cleaned" -eq 0 ]; then
  info "  (nenhum arquivo legado encontrado)"
fi

# ── Install ───────────────────────────────────────────────────────────────────
echo ""
info "Installing agents..."
for f in "${REPO_DIR}/agents"/forge*.md; do
  name="$(basename "$f")"
  copy "$f" "${AGENTS_DIR}/${name}"
  info "  agents/${name}"
done

echo ""
info "Installing commands..."
for f in "${REPO_DIR}/commands"/forge*.md; do
  name="$(basename "$f")"
  copy "$f" "${COMMANDS_DIR}/${name}"
  info "  commands/${name}"
done

echo ""
info "Installing skills..."
SKILLS_DIR_AGENTS="${HOME}/.agents/skills"
SKILLS_DIR_CLAUDE="${CLAUDE_DIR}/skills"
# Install to ~/.agents/skills (skills.sh ecosystem, compatible with gsd-pi)
# AND ~/.claude/skills (Claude Code native)
for skill_dir in "${REPO_DIR}/skills"/*/; do
  skill_name="$(basename "$skill_dir")"
  for target in "$SKILLS_DIR_AGENTS" "$SKILLS_DIR_CLAUDE"; do
    dst="${target}/${skill_name}"
    if $DRY_RUN; then
      dry "install skill ${skill_name} → ${target}/"
    else
      mkdir -p "$dst"
      cp -r "${skill_dir}"* "$dst/"
    fi
  done
  info "  ${skill_name}"
done

echo ""
info "Installing preferences..."
PREFS_DST="${CLAUDE_DIR}/forge-agent-prefs.md"
if [ ! -f "$PREFS_DST" ]; then
  copy "${REPO_DIR}/forge-agent-prefs.md" "$PREFS_DST"
  info "  forge-agent-prefs.md (novo)"
else
  info "  forge-agent-prefs.md já existe — não sobrescrito"
  info "  (suas preferências foram mantidas)"
fi

# ── Store repo path for /forge-update ──────────────────────────────────────────
# Use sed -i '' for macOS (BSD sed) compatibility; GNU sed ignores the empty string arg
_sed_inplace() { sed -i '' "$@" 2>/dev/null || sed -i "$@"; }

if ! $DRY_RUN && [ -f "$PREFS_DST" ]; then
  if grep -q "^repo_path:" "$PREFS_DST" 2>/dev/null; then
    _sed_inplace "s|^repo_path:.*|repo_path: ${REPO_DIR}|" "$PREFS_DST"
  else
    # Append repo_path under Update Settings section if present, else append at end
    if grep -q "repo_path:" "$PREFS_DST" 2>/dev/null; then
      _sed_inplace "s|repo_path:.*|repo_path: ${REPO_DIR}|" "$PREFS_DST"
    else
      printf '\n## Update Settings\n\n```\nrepo_path: %s\n```\n' "${REPO_DIR}" >> "$PREFS_DST"
    fi
  fi
  info "  repo_path gravado: ${REPO_DIR}"
fi

# ── Install statusline + hooks ────────────────────────────────────────────────
echo ""
info "Installing statusline & hooks..."
copy "${REPO_DIR}/scripts/forge-statusline.js" "${CLAUDE_DIR}/forge-statusline.js"
info "  forge-statusline.js"
copy "${REPO_DIR}/scripts/forge-hook.js" "${CLAUDE_DIR}/forge-hook.js"
info "  forge-hook.js"
copy "${REPO_DIR}/scripts/merge-settings.js" "${CLAUDE_DIR}/forge-settings.js"
info "  forge-settings.js"
info ""
info "  Status line não ativada por padrão."
info "  Para ativar: /forge-config statusline on"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════"
if $DRY_RUN; then
  echo "Dry run completo. Nenhum arquivo foi alterado."
else
  success "GSD Agent instalado com sucesso!"
  echo ""
  echo "  Próximos passos:"
  echo "  1. Navegue até um projeto:  cd /seu/projeto"
  echo "  2. Abra o Claude Code:      claude"
  echo "  3. Inicialize o projeto:    /forge-init"
  echo "  4. Crie um milestone:       /forge-new-milestone <descrição>"
  echo "  5. Execute:                 /forge-auto"
  echo ""
  echo "  Ajuda a qualquer momento:   /forge-help"
fi
echo ""
