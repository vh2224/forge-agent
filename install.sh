#!/usr/bin/env bash
# GSD Agent — Installer for Claude Code (macOS / Linux / Windows Git Bash)
# Usage: bash install.sh [--update] [--dry-run]

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"
BACKUP_DIR="${CLAUDE_DIR}/gsd-agent-backup-$(date +%Y%m%d%H%M%S)"
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
for f in "${AGENTS_DIR}"/gsd*.md "${COMMANDS_DIR}"/gsd*.md "${CLAUDE_DIR}/gsd-agent-prefs.md"; do
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
    for f in "${AGENTS_DIR}"/gsd*.md; do [ -f "$f" ] && cp "$f" "$BACKUP_DIR/agents/"; done
    for f in "${COMMANDS_DIR}"/gsd*.md; do [ -f "$f" ] && cp "$f" "$BACKUP_DIR/commands/"; done
    [ -f "${CLAUDE_DIR}/gsd-agent-prefs.md" ] && cp "${CLAUDE_DIR}/gsd-agent-prefs.md" "$BACKUP_DIR/"
  fi
  success "Backup saved to $BACKUP_DIR"
fi

# ── Install ───────────────────────────────────────────────────────────────────
echo ""
info "Installing agents..."
for f in "${REPO_DIR}/agents"/gsd*.md; do
  name="$(basename "$f")"
  copy "$f" "${AGENTS_DIR}/${name}"
  info "  agents/${name}"
done

echo ""
info "Installing commands..."
for f in "${REPO_DIR}/commands"/gsd*.md; do
  name="$(basename "$f")"
  copy "$f" "${COMMANDS_DIR}/${name}"
  info "  commands/${name}"
done

echo ""
info "Installing preferences..."
PREFS_DST="${CLAUDE_DIR}/gsd-agent-prefs.md"
if [ ! -f "$PREFS_DST" ]; then
  copy "${REPO_DIR}/gsd-agent-prefs.md" "$PREFS_DST"
  info "  gsd-agent-prefs.md (novo)"
else
  info "  gsd-agent-prefs.md já existe — não sobrescrito"
  info "  (suas preferências foram mantidas)"
fi

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
  echo "  3. Inicialize o projeto:    /gsd-init"
  echo "  4. Crie um milestone:       /gsd-new-milestone <descrição>"
  echo "  5. Execute:                 /gsd-auto"
  echo ""
  echo "  Ajuda a qualquer momento:   /gsd-help"
fi
echo ""
