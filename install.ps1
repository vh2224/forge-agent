# Forge Agent — Installer for Claude Code (Windows PowerShell)
# Usage: .\install.ps1 [-Update] [-DryRun]

param(
    [switch]$Update,
    [switch]$DryRun,
    [switch]$NoModelProbe
)

$ErrorActionPreference = "Stop"

# ── Config ───────────────────────────────────────────────────────────────────
$RepoDir    = $PSScriptRoot
$ClaudeDir  = "$env:USERPROFILE\.claude"
$AgentsDir  = "$ClaudeDir\agents"
$CommandsDir = "$ClaudeDir\commands"
$BackupDir  = "$ClaudeDir\forge-agent-backup-$(Get-Date -Format 'yyyyMMddHHmmss')"

function Info($msg)    { Write-Host "  $msg" }
function Success($msg) { Write-Host "✓ $msg" -ForegroundColor Green }
function Warn($msg)    { Write-Host "⚠ $msg" -ForegroundColor Yellow }
function Dry($msg)     { Write-Host "  [dry-run] $msg" -ForegroundColor Cyan }

function CopyFile($src, $dst) {
    if ($DryRun) {
        Dry "cp $src → $dst"
    } else {
        $dir = Split-Path $dst -Parent
        if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Copy-Item $src $dst -Force
    }
}

# ── Header ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Forge Agent Installer" -ForegroundColor Cyan
Write-Host "═══════════════════════"
Write-Host ""

# ── Detect Claude Code ────────────────────────────────────────────────────────
if (!(Test-Path $ClaudeDir)) {
    Write-Host "✗ Claude Code não encontrado em: $ClaudeDir" -ForegroundColor Red
    Write-Host "  Instale o Claude Code primeiro: https://claude.ai/code"
    exit 1
}
Success "Claude Code encontrado em $ClaudeDir"

# ── Check existing installation ───────────────────────────────────────────────
$hasExisting = (Get-ChildItem "$AgentsDir\forge*.md" -ErrorAction SilentlyContinue) -or
               (Get-ChildItem "$CommandsDir\forge*.md" -ErrorAction SilentlyContinue) -or
               (Test-Path "$ClaudeDir\forge-agent-prefs.md")

if ($hasExisting -and -not $Update) {
    Write-Host ""
    Warn "Forge Agent já está instalado."
    Write-Host "  Execute com -Update para atualizar (backup automático):"
    Write-Host "  .\install.ps1 -Update"
    exit 0
}

if ($hasExisting -and $Update) {
    if (-not $DryRun) {
        New-Item -ItemType Directory "$BackupDir\agents" -Force | Out-Null
        New-Item -ItemType Directory "$BackupDir\commands" -Force | Out-Null
        Get-ChildItem "$AgentsDir\forge*.md"   -ErrorAction SilentlyContinue | Copy-Item -Destination "$BackupDir\agents\"
        Get-ChildItem "$CommandsDir\forge*.md" -ErrorAction SilentlyContinue | Copy-Item -Destination "$BackupDir\commands\"
        if (Test-Path "$ClaudeDir\forge-agent-prefs.md") { Copy-Item "$ClaudeDir\forge-agent-prefs.md" $BackupDir }
        if (Test-Path "$ClaudeDir\forge-statusline.js")  { Copy-Item "$ClaudeDir\forge-statusline.js"  $BackupDir }
        if (Test-Path "$ClaudeDir\forge-hook.js")        { Copy-Item "$ClaudeDir\forge-hook.js"        $BackupDir }
        if (Test-Path "$ClaudeDir\forge-settings.js")   { Copy-Item "$ClaudeDir\forge-settings.js"   $BackupDir }
    }
    Success "Backup salvo em $BackupDir"
}

# ── Clean up legacy gsd-* files ──────────────────────────────────────────────
Write-Host ""
Info "Limpando arquivos legados gsd-*..."
$cleaned = 0
foreach ($f in Get-ChildItem "$AgentsDir\gsd-*.md" -ErrorAction SilentlyContinue) {
    if ($DryRun) {
        Dry "rm $($f.FullName)"
    } else {
        Remove-Item $f.FullName -Force
    }
    Info "  removed agents\$($f.Name)"
    $cleaned++
}
foreach ($f in Get-ChildItem "$CommandsDir\gsd-*.md" -ErrorAction SilentlyContinue) {
    if ($DryRun) {
        Dry "rm $($f.FullName)"
    } else {
        Remove-Item $f.FullName -Force
    }
    Info "  removed commands\$($f.Name)"
    $cleaned++
}
foreach ($d in @("$ClaudeDir\skills", "$env:USERPROFILE\.agents\skills")) {
    foreach ($skillDir in Get-ChildItem "$d\gsd-*" -Directory -ErrorAction SilentlyContinue) {
        if ($DryRun) {
            Dry "rm -rf $($skillDir.FullName)"
        } else {
            Remove-Item $skillDir.FullName -Recurse -Force
        }
        Info "  removed skills\$($skillDir.Name)"
        $cleaned++
    }
}
if ($cleaned -eq 0) {
    Info "  (nenhum arquivo legado encontrado)"
}

# ── Install agents ────────────────────────────────────────────────────────────
Write-Host ""
Info "Instalando agentes..."
foreach ($f in Get-ChildItem "$RepoDir\agents\forge*.md") {
    CopyFile $f.FullName "$AgentsDir\$($f.Name)"
    Info "  agents\$($f.Name)"
}

# ── Opus model availability probe ─────────────────────────────────────────────
# Agents default to claude-opus-4-7[1m]. If the user's account doesn't have access
# (tier/region), downgrade the installed agent frontmatters to claude-opus-4-6.
# Runs a minimal API probe (~1 token). Skip with -NoModelProbe.
function Downgrade-OpusTo46 {
    foreach ($agent in @("forge-planner.md", "forge-discusser.md", "forge-researcher.md")) {
        $file = "$AgentsDir\$agent"
        if (!(Test-Path $file)) { continue }
        if ($DryRun) {
            Dry "downgrade model in agents\${agent}: claude-opus-4-7[1m] → claude-opus-4-6"
        } else {
            $content = Get-Content $file -Raw
            $content = $content -replace '(?m)^model: "claude-opus-4-7\[1m\]"$', 'model: claude-opus-4-6'
            Set-Content $file $content -NoNewline
        }
    }
}

# Sync opus model references in prefs file with the current agent frontmatter model.
# Replaces both `claude-opus-4-6` and `claude-opus-4-7[1m]` with $Target.
# Touches only opus model strings — sonnet/haiku and user customizations for other
# models are preserved. If user explicitly pinned a phase to claude-opus-4-6, they
# must reapply manually (edge case; documented in installer output).
function Sync-PrefsOpusModel {
    param([string]$Target, [string]$PrefsFile)
    if (!(Test-Path $PrefsFile)) { return }
    if ($DryRun) {
        Dry "sync prefs opus references → $Target"
        return
    }
    $content = Get-Content $PrefsFile -Raw
    # Placeholder approach: collapse both IDs to a temp token, then expand to Target.
    # Escape regex-special brackets in the source patterns only.
    $content = $content -replace 'claude-opus-4-7\[1m\]', '@@FORGE_OPUS_TMP@@'
    $content = $content -replace 'claude-opus-4-6', '@@FORGE_OPUS_TMP@@'
    $content = $content -replace '@@FORGE_OPUS_TMP@@', $Target
    Set-Content $PrefsFile $content -NoNewline
}

$script:OpusTarget = "claude-opus-4-7[1m]"  # default; flipped to claude-opus-4-6 on downgrade
$script:SyncPrefs  = $true                   # false when probe inconclusive

$ClaudeForProbe = Get-Command claude -ErrorAction SilentlyContinue

if ($DryRun) {
    # skip probe in dry-run
} elseif ($NoModelProbe) {
    Info ""
    Info "  (-NoModelProbe: mantendo claude-opus-4-7[1m] como padrão)"
} elseif (-not $ClaudeForProbe) {
    Info ""
    Info "  Claude CLI não encontrado — probe de modelo pulado (mantendo claude-opus-4-7[1m])"
    $script:SyncPrefs = $false  # can't verify — leave prefs untouched
} else {
    Write-Host ""
    Info "Verificando disponibilidade de claude-opus-4-7[1m]..."
    $probeOut = ""
    $probeExit = 1
    try {
        $probeOut = & claude -p "ok" --model 'claude-opus-4-7[1m]' --max-turns 1 2>&1 | Out-String
        $probeExit = $LASTEXITCODE
    } catch {
        $probeOut = $_.Exception.Message
        $probeExit = 1
    }
    if ($probeExit -eq 0) {
        Success "  claude-opus-4-7[1m] disponível — usando como modelo Opus padrão"
    } elseif ($probeOut -imatch "model.*not.*(found|available|supported|allowed)|invalid.*model|404|not_found|does not have access|issue with.*model|may not exist|may not have access") {
        Warn "  claude-opus-4-7[1m] indisponível nesta conta — fallback para claude-opus-4-6"
        Downgrade-OpusTo46
        Info "  Agents atualizados: forge-planner, forge-discusser, forge-researcher"
        $script:OpusTarget = "claude-opus-4-6"
    } else {
        Info "  Probe inconclusivo (erro não relacionado a modelo) — mantendo claude-opus-4-7[1m]"
        Info "  Se houver problemas em runtime, rode: .\install.ps1 -Update (com conectividade)"
        $script:SyncPrefs = $false  # can't verify — leave prefs untouched
    }
}

# ── Install commands ──────────────────────────────────────────────────────────
Write-Host ""
Info "Instalando comandos..."
# Remove commands that no longer exist in the repo (migrated to skills)
foreach ($f in Get-ChildItem "$CommandsDir\forge*.md" -ErrorAction SilentlyContinue) {
    if (!(Test-Path "$RepoDir\commands\$($f.Name)")) {
        if ($DryRun) {
            Dry "rm $($f.FullName) (migrated to skill)"
        } else {
            Remove-Item $f.FullName -Force
        }
        Info "  removed commands\$($f.Name) (migrated to skill)"
    }
}
foreach ($f in Get-ChildItem "$RepoDir\commands\forge*.md") {
    CopyFile $f.FullName "$CommandsDir\$($f.Name)"
    Info "  commands\$($f.Name)"
}

# ── Install skills ────────────────────────────────────────────────────────────
Write-Host ""
Info "Instalando skills..."
$SkillsDirAgents = "$env:USERPROFILE\.agents\skills"
$SkillsDirClaude = "$ClaudeDir\skills"
foreach ($skillDir in Get-ChildItem "$RepoDir\skills" -Directory) {
    $skillName = $skillDir.Name
    foreach ($target in @($SkillsDirAgents, $SkillsDirClaude)) {
        $dst = "$target\$skillName"
        if ($DryRun) {
            Dry "install skill $skillName → $target\"
        } else {
            New-Item -ItemType Directory -Path $dst -Force | Out-Null
            Copy-Item "$($skillDir.FullName)\*" $dst -Recurse -Force
        }
    }
    Info "  $skillName"
}

# ── Install preferences ───────────────────────────────────────────────────────
Write-Host ""
Info "Instalando preferências..."
$prefsFile = "$ClaudeDir\forge-agent-prefs.md"
if (!(Test-Path $prefsFile)) {
    CopyFile "$RepoDir\forge-agent-prefs.md" $prefsFile
    Info "  forge-agent-prefs.md (novo)"
} else {
    Info "  forge-agent-prefs.md já existe — mantido"
    Info "  (suas preferências não foram alteradas)"
}

# ── Store repo path for /forge-update ──────────────────────────────────────────
if (-not $DryRun -and (Test-Path $prefsFile)) {
    $prefsContent = Get-Content $prefsFile -Raw
    $repoPathLine = "repo_path: $RepoDir"
    if ($prefsContent -match "^repo_path:") {
        # Update existing line
        $prefsContent = $prefsContent -replace "(?m)^repo_path:.*", $repoPathLine
        Set-Content $prefsFile $prefsContent -NoNewline
    } elseif ($prefsContent -match "repo_path:") {
        # Update placeholder line
        $prefsContent = $prefsContent -replace "repo_path:[^\n]*", $repoPathLine
        Set-Content $prefsFile $prefsContent -NoNewline
    } else {
        # Append at end
        Add-Content $prefsFile "`n## Update Settings`n`n``````repo_path: $RepoDir`n``````"
    }
    Info "  repo_path gravado: $RepoDir"
}

# ── Sync prefs opus model with agent frontmatter ──────────────────────────────
# The orchestrator reads the model ID from forge-agent-prefs.md to display the model
# in TaskCreate descriptions. When agents are upgraded (or downgraded) by the probe,
# the prefs file must be rewritten to match — otherwise the UI shows one model while
# Agent() dispatches another (the frontmatter wins at dispatch time).
if ($script:SyncPrefs -and (Test-Path $prefsFile)) {
    if ($DryRun) {
        Dry "sync prefs opus model → $($script:OpusTarget)"
    } else {
        Sync-PrefsOpusModel -Target $script:OpusTarget -PrefsFile $prefsFile
        Info "  prefs opus model sincronizado: $($script:OpusTarget)"
        Info "  (se você fixou uma fase em claude-opus-4-6 manualmente, reaplique via /forge-prefs)"
    }
}

# ── Install shared references ─────────────────────────────────────────────────
Write-Host ""
Info "Instalando referências compartilhadas..."
CopyFile "$RepoDir\shared\forge-dispatch.md" "$ClaudeDir\forge-dispatch.md"
Info "  forge-dispatch.md"
if (Test-Path "$RepoDir\shared\forge-mcps.md") {
    CopyFile "$RepoDir\shared\forge-mcps.md" "$ClaudeDir\forge-mcps.md"
    Info "  forge-mcps.md"
}
if (Test-Path "$RepoDir\shared\forge-domain-probes.md") {
    CopyFile "$RepoDir\shared\forge-domain-probes.md" "$ClaudeDir\forge-domain-probes.md"
    Info "  forge-domain-probes.md"
}

# ── Install statusline + hooks ────────────────────────────────────────────────
Write-Host ""
Info "Instalando statusline & hooks..."
CopyFile "$RepoDir\scripts\forge-statusline.js" "$ClaudeDir\forge-statusline.js"
Info "  forge-statusline.js"
CopyFile "$RepoDir\scripts\forge-hook.js" "$ClaudeDir\forge-hook.js"
Info "  forge-hook.js"
CopyFile "$RepoDir\scripts\merge-settings.js" "$ClaudeDir\forge-settings.js"
Info "  forge-settings.js"
Info ""
Info "  Status line não ativada por padrão."
Info "  Para ativar: /forge-config statusline on"

# Re-register hooks when statusline is already active — picks up new hook events
# added in later versions (SubagentStart/Stop, PreCompact/PostCompact, ...) without
# requiring the user to toggle the statusline off and on again.
$SettingsFile  = Join-Path $ClaudeDir "settings.json"
$SettingsScript = Join-Path $ClaudeDir "forge-settings.js"
if (-not $DryRun -and (Test-Path $SettingsFile)) {
    $StatusActive = $false
    try {
        $Existing = Get-Content $SettingsFile -Raw | ConvertFrom-Json
        if ($Existing.statusLine -and $Existing.statusLine.command -and ($Existing.statusLine.command -like "*forge-statusline.js*")) {
            $StatusActive = $true
        }
    } catch {}

    if ($StatusActive) {
        Write-Host ""
        Info "Statusline ativa detectada — re-registrando hooks em settings.json..."
        $null = & node $SettingsScript $SettingsFile 2>&1
        if ($LASTEXITCODE -eq 0) {
            Success "  hooks sincronizados (inclui SubagentStart/Stop, PreCompact/PostCompact)"
        } else {
            Info "  falha ao re-registrar — rode manualmente: node ~/.claude/forge-settings.js ~/.claude/settings.json"
        }
    }
}

# ── Tier 1 MCPs: fetch + context7 (via `claude mcp add -s user`) ─────────────
# Claude Code CLI lê MCPs de ~/.claude.json (user-scope registry), NÃO de
# ~/.claude/settings.json. Usar o CLI oficial é a única forma de registrar.
$SkipFile    = Join-Path $ClaudeDir "forge-mcps-skipped.txt"
$ClaudeCmd   = Get-Command claude -ErrorAction SilentlyContinue

if (-not $DryRun -and $ClaudeCmd) {
    Write-Host ""
    Write-Host "────────────────────"
    Write-Host "  MCPs globais (Tier 1 — zero-config)"
    Write-Host "────────────────────"
    Write-Host ""

    $installedList = ""
    try { $installedList = & claude mcp list 2>$null | Out-String } catch {}

    function Add-Tier1Mcp($name, $configJson) {
        if ((Test-Path $SkipFile) -and ((Get-Content $SkipFile -ErrorAction SilentlyContinue) -contains $name)) {
            Info "  $name — pulado (marcado como skip pelo usuário)"
            return
        }
        if ($installedList -match "(?m)^$name[:\s]") {
            Info "  $name — já configurado"
            return
        }
        # add-json aceita a config inteira em JSON. PowerShell 5.1 strippa aspas
        # duplas ao passar args para exe externo — escapar `"` como `\"` preserva
        # o JSON literal que o CLI do Claude precisa receber.
        $escaped = $configJson -replace '"', '\"'
        & claude mcp add-json $name $escaped -s user 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Success "  $name — adicionado"
        } else {
            Info "  $name — falha ao adicionar (rode manualmente: claude mcp add-json $name '$configJson' -s user)"
        }
    }

    Add-Tier1Mcp "fetch"    '{"command":"npx","args":["-y","mcp-fetch-server"]}'
    Add-Tier1Mcp "context7" '{"command":"npx","args":["-y","@upstash/context7-mcp@latest"]}'
    Write-Host ""
    Info "Pesquisa web (Anthropic WebSearch nativo) já funciona sem MCP ou chave."
    Info "Para search determinístico (Brave, 2000q/mês grátis): /forge-mcps add brave-search"
} elseif (-not $DryRun) {
    Info ""
    Info "Claude CLI não encontrado no PATH — MCPs Tier 1 não foram instalados."
    Info "Após instalar o Claude Code, rode: /forge-mcps"
}

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "═══════════════════════"
if ($DryRun) {
    Write-Host "Dry run completo. Nenhum arquivo alterado." -ForegroundColor Cyan
} else {
    Success "Forge Agent instalado com sucesso!"
    Write-Host ""
    Write-Host "  Próximos passos:"
    Write-Host "  1. Navegue até um projeto:  cd C:\seu\projeto"
    Write-Host "  2. Abra o Claude Code:      claude"
    Write-Host "  3. Inicialize o projeto:    /forge-init"
    Write-Host "  4. Crie um milestone:       /forge-new-milestone <descrição>"
    Write-Host "  5. Execute:                 /forge-auto"
    Write-Host ""
    Write-Host "  Ajuda a qualquer momento:   /forge-help"
}
Write-Host ""
