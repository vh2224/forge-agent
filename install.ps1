# GSD Agent — Installer for Claude Code (Windows PowerShell)
# Usage: .\install.ps1 [-Update] [-DryRun]

param(
    [switch]$Update,
    [switch]$DryRun
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
Write-Host "GSD Agent Installer" -ForegroundColor Cyan
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
$hasExisting = (Get-ChildItem "$AgentsDirorge*.md" -ErrorAction SilentlyContinue) -or
               (Get-ChildItem "$CommandsDirorge*.md" -ErrorAction SilentlyContinue) -or
               (Test-Path "$ClaudeDir\forge-agent-prefs.md")

if ($hasExisting -and -not $Update) {
    Write-Host ""
    Warn "GSD Agent já está instalado."
    Write-Host "  Execute com -Update para atualizar (backup automático):"
    Write-Host "  .\install.ps1 -Update"
    exit 0
}

if ($hasExisting -and $Update) {
    if (-not $DryRun) {
        New-Item -ItemType Directory "$BackupDir\agents" -Force | Out-Null
        New-Item -ItemType Directory "$BackupDir\commands" -Force | Out-Null
        Get-ChildItem "$AgentsDirorge*.md"   -ErrorAction SilentlyContinue | Copy-Item -Destination "$BackupDir\agents\"
        Get-ChildItem "$CommandsDirorge*.md" -ErrorAction SilentlyContinue | Copy-Item -Destination "$BackupDir\commands\"
        if (Test-Path "$ClaudeDir\forge-agent-prefs.md") {
            Copy-Item "$ClaudeDir\forge-agent-prefs.md" $BackupDir
        }
    }
    Success "Backup salvo em $BackupDir"
}

# ── Install agents ────────────────────────────────────────────────────────────
Write-Host ""
Info "Instalando agentes..."
foreach ($f in Get-ChildItem "$RepoDir\agentsorge*.md") {
    CopyFile $f.FullName "$AgentsDir\$($f.Name)"
    Info "  agents\$($f.Name)"
}

# ── Install commands ──────────────────────────────────────────────────────────
Write-Host ""
Info "Instalando comandos..."
foreach ($f in Get-ChildItem "$RepoDir\commandsorge*.md") {
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

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "═══════════════════════"
if ($DryRun) {
    Write-Host "Dry run completo. Nenhum arquivo alterado." -ForegroundColor Cyan
} else {
    Success "GSD Agent instalado com sucesso!"
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
