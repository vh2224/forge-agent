#!/usr/bin/env bash
# Forge Agent — Installer for Claude Code (macOS / Linux / Windows Git Bash)
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
NO_MODEL_PROBE=false

# ── Args ─────────────────────────────────────────────────────────────────────
for arg in "$@"; do
  case $arg in
    --dry-run)         DRY_RUN=true         ;;
    --update)          UPDATE=true          ;;
    --no-model-probe)  NO_MODEL_PROBE=true  ;;
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
echo "Forge Agent Installer"
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
  warn "Forge Agent files already exist."
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
    [ -f "${CLAUDE_DIR}/forge-dispatch.md"     ] && cp "${CLAUDE_DIR}/forge-dispatch.md"     "$BACKUP_DIR/"
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
for d in "${CLAUDE_DIR}/skills"/gsd-* "${HOME}/.agents/skills"/gsd-*; do
  [ -d "$d" ] || continue
  if $DRY_RUN; then
    dry "rm -rf $d"
  else
    rm -rf "$d"
  fi
  info "  removed skills/$(basename "$d")"
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

# ── Opus model availability probe ─────────────────────────────────────────────
# Agents default to claude-opus-4-7[1m]. If the user's account doesn't have access
# (tier/region), downgrade the installed agent frontmatters to claude-opus-4-6.
# Runs a minimal API probe (~1 token). Skip with --no-model-probe.
_sed_inplace_probe() { sed -i '' "$@" 2>/dev/null || sed -i "$@"; }

OPUS_TARGET="claude-opus-4-7[1m]"  # default; flipped to claude-opus-4-6 on probe downgrade
SYNC_PREFS=true                     # default; false when probe is inconclusive (keep prefs unchanged)

downgrade_opus_to_46() {
  for agent in forge-planner.md forge-discusser.md forge-researcher.md; do
    local f="${AGENTS_DIR}/${agent}"
    [ -f "$f" ] || continue
    if $DRY_RUN; then
      dry "downgrade model in agents/${agent}: claude-opus-4-7[1m] → claude-opus-4-6"
    else
      _sed_inplace_probe 's|^model: "claude-opus-4-7\[1m\]"$|model: claude-opus-4-6|' "$f"
    fi
  done
}

# Sync opus model references in prefs file with the current agent frontmatter model.
# Replaces both `claude-opus-4-6` and `claude-opus-4-7[1m]` with $1 (target).
# Touches only opus model strings — sonnet/haiku refs and user-customized rows for other
# models are preserved. If user explicitly pinned a phase to claude-opus-4-6, they must
# reapply manually after install (edge case; documented in installer output).
sync_prefs_opus_model() {
  local target="$1"
  local prefs="${CLAUDE_DIR}/forge-agent-prefs.md"
  [ -f "$prefs" ] || return 0
  if $DRY_RUN; then
    dry "sync prefs opus references → ${target}"
    return 0
  fi
  # Placeholder approach: collapse both IDs to a temp token, then expand to target.
  # [1m] contains regex-special brackets — escape in the pattern only.
  _sed_inplace_probe "s|claude-opus-4-7\[1m\]|@@FORGE_OPUS_TMP@@|g; s|claude-opus-4-6|@@FORGE_OPUS_TMP@@|g; s|@@FORGE_OPUS_TMP@@|${target}|g" "$prefs"
}

if $DRY_RUN; then
  :  # skip probe in dry-run
elif $NO_MODEL_PROBE; then
  info ""
  info "  (--no-model-probe: mantendo claude-opus-4-7[1m] como padrão)"
elif ! command -v claude >/dev/null 2>&1; then
  info ""
  info "  Claude CLI não encontrado — probe de modelo pulado (mantendo claude-opus-4-7[1m])"
  SYNC_PREFS=false  # can't verify — leave prefs untouched
else
  echo ""
  info "Verificando disponibilidade de claude-opus-4-7[1m]..."
  set +e
  probe_out=$(claude -p "ok" --model 'claude-opus-4-7[1m]' --max-turns 1 2>&1)
  probe_exit=$?
  set -e
  if [ $probe_exit -eq 0 ]; then
    success "  claude-opus-4-7[1m] disponível — usando como modelo Opus padrão"
  elif echo "$probe_out" | grep -qiE "model.*not.*(found|available|supported|allowed)|invalid.*model|404|not_found|does not have access|issue with.*model|may not exist|may not have access"; then
    warn "  claude-opus-4-7[1m] indisponível nesta conta — fallback para claude-opus-4-6"
    downgrade_opus_to_46
    info "  Agents atualizados: forge-planner, forge-discusser, forge-researcher"
    OPUS_TARGET="claude-opus-4-6"
  else
    info "  Probe inconclusivo (erro não relacionado a modelo) — mantendo claude-opus-4-7[1m]"
    info "  Se houver problemas em runtime, rode: bash install.sh --update (com conectividade)"
    SYNC_PREFS=false  # can't verify — leave prefs untouched
  fi
fi

echo ""
info "Installing commands..."
# Remove commands that no longer exist in the repo (migrated to skills)
for f in "${COMMANDS_DIR}"/forge*.md; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  if [ ! -f "${REPO_DIR}/commands/${name}" ]; then
    if $DRY_RUN; then
      dry "rm ${f} (migrated to skill)"
    else
      rm "$f"
    fi
    info "  removed commands/${name} (migrated to skill)"
  fi
done
for f in "${REPO_DIR}/commands"/forge*.md; do
  name="$(basename "$f")"
  copy "$f" "${COMMANDS_DIR}/${name}"
  info "  commands/${name}"
done

echo ""
info "Installing scripts..."
SCRIPTS_DIR="${CLAUDE_DIR}/scripts"
mkdir -p "$SCRIPTS_DIR"
for f in "${REPO_DIR}/scripts"/*.sh; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  copy "$f" "${SCRIPTS_DIR}/${name}"
  chmod +x "${SCRIPTS_DIR}/${name}" 2>/dev/null || true
  info "  scripts/${name}"
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

# ── Sync prefs opus model with agent frontmatter ──────────────────────────────
# The orchestrator reads the model ID from forge-agent-prefs.md to display the model
# in TaskCreate descriptions. When agents are upgraded (or downgraded) by the probe,
# the prefs file must be rewritten to match — otherwise the UI shows one model while
# Agent() dispatches another (the frontmatter wins at dispatch time).
if $SYNC_PREFS && [ -f "$PREFS_DST" ]; then
  if $DRY_RUN; then
    dry "sync prefs opus model → ${OPUS_TARGET}"
  else
    sync_prefs_opus_model "$OPUS_TARGET"
    info "  prefs opus model sincronizado: ${OPUS_TARGET}"
    info "  (se você fixou uma fase em claude-opus-4-6 manualmente, reaplique via /forge-prefs)"
  fi
fi

# ── Install statusline + hooks ────────────────────────────────────────────────
echo ""
info "Installing shared references..."
copy "${REPO_DIR}/shared/forge-dispatch.md" "${CLAUDE_DIR}/forge-dispatch.md"
info "  forge-dispatch.md"
if [ -f "${REPO_DIR}/shared/forge-mcps.md" ]; then
  copy "${REPO_DIR}/shared/forge-mcps.md" "${CLAUDE_DIR}/forge-mcps.md"
  info "  forge-mcps.md"
fi
if [ -f "${REPO_DIR}/shared/forge-domain-probes.md" ]; then
  copy "${REPO_DIR}/shared/forge-domain-probes.md" "${CLAUDE_DIR}/forge-domain-probes.md"
  info "  forge-domain-probes.md"
fi

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

# ── Global MCP setup (via `claude mcp add -s user`) ───────────────────────────
# Claude Code CLI reads MCPs from ~/.claude.json (user-scope registry), NOT from
# ~/.claude/settings.json. We must use the official CLI to register them — writing
# settings.json directly has zero effect on MCP discovery.

if ! $DRY_RUN && command -v claude >/dev/null 2>&1; then
  echo ""
  echo "────────────────────"
  echo "  MCPs globais (Tier 1 — zero-config)"
  echo "────────────────────"
  echo ""

  SKIP_FILE="${CLAUDE_DIR}/forge-mcps-skipped.txt"
  installed_list=$(claude mcp list 2>/dev/null || echo "")

  tier1_add() {
    local name="$1"; shift
    if [ -f "$SKIP_FILE" ] && grep -q "^${name}$" "$SKIP_FILE" 2>/dev/null; then
      info "  ${name} — pulado (marcado como skip pelo usuário)"
      return
    fi
    if echo "$installed_list" | grep -qE "^${name}[: ]"; then
      info "  ${name} — já configurado"
      return
    fi
    claude mcp add "$name" -s user -- "$@" >/dev/null 2>&1 \
      && success "  ${name} — adicionado" \
      || info "  ${name} — falha ao adicionar (rode manualmente: claude mcp add ${name} -s user -- $*)"
  }

  tier1_add fetch    npx -y mcp-fetch-server
  tier1_add context7 npx -y @upstash/context7-mcp@latest
  echo ""
  info "Pesquisa web (Anthropic WebSearch nativo) já funciona sem MCP ou chave."
  info "Para search determinístico (Brave, 2000q/mês grátis): /forge-mcps add brave-search"

  if ! $UPDATE && [ -t 0 ]; then
    echo ""
    read -rp "  Remover algum MCP Tier 1 desta instalação? (fetch/context7/nenhum) [nenhum]: " remove_choice
    remove_choice="${remove_choice:-nenhum}"
    case "$remove_choice" in
      fetch|context7)
        claude mcp remove "$remove_choice" -s user >/dev/null 2>&1 || true
        echo "$remove_choice" >> "$SKIP_FILE"
        info "  ${remove_choice} removido e marcado como skip"
        ;;
    esac
  fi

  if ! $UPDATE && [ -t 0 ]; then
    while true; do
      echo ""
      read -rp "  Adicionar outro MCP global? (nome ou 'não' para continuar) [não]: " custom_name
      custom_name="${custom_name:-não}"

      if [[ "$custom_name" =~ ^[nN] ]] || [ "$custom_name" = "não" ]; then
        break
      fi

      read -rp "  Comando (ex: npx, uvx, node): " custom_cmd
      read -rp "  Argumentos (ex: -y @meu/mcp-server): " custom_args
      read -rp "  Variáveis de ambiente (KEY=val KEY2=val2, ou vazio): " custom_env

      env_flags=()
      if [ -n "$custom_env" ]; then
        for pair in $custom_env; do
          env_flags+=(-e "$pair")
        done
      fi

      claude mcp add "$custom_name" -s user "${env_flags[@]}" -- "$custom_cmd" $custom_args \
        && success "  ${custom_name} — adicionado" \
        || info "  ${custom_name} — falha ao adicionar"
    done

    echo ""
    info "MCPs globais configurados:"
    claude mcp list 2>/dev/null || true
  fi
elif ! $DRY_RUN; then
  info ""
  info "Claude CLI não encontrado no PATH — MCPs Tier 1 não foram instalados."
  info "Após instalar o Claude Code, rode: /forge-mcps"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════"
if $DRY_RUN; then
  echo "Dry run completo. Nenhum arquivo foi alterado."
else
  success "Forge Agent instalado com sucesso!"
  echo ""
  echo "  Próximos passos:"
  echo "  1. Navegue até um projeto:  cd /seu/projeto"
  echo "  2. Abra o Claude Code:      claude"
  echo "  3. Inicialize o projeto:    /forge-init"
  echo "  4. Crie um milestone:       /forge-new-milestone <descrição>"
  echo "  5. Execute:                 /forge-auto"
  echo ""
  echo "  MCPs de projeto (postgres, redis) serão sugeridos no /forge-init."
  echo "  Gerenciar MCPs a qualquer momento: /forge-mcps"
  echo ""
  echo "  Ajuda a qualquer momento:   /forge-help"
fi
echo ""
