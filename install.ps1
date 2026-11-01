<#[
Forge Agent installer wrapper for native Windows PowerShell.

Examples:
  .\install.ps1 -Runtime claude -DryRun
  .\install.ps1 -Runtime codex -Update
  .\install.ps1 -Runtime both -NoModelProbe
  .\install.ps1 -Update -WithVscodePanel
]
#>
param(
  [ValidateSet('claude', 'codex', 'both')]
  [string]$Runtime = 'claude',
  [switch]$Update,
  [switch]$DryRun,
  [switch]$NoModelProbe,
  [switch]$WithApp,
  [switch]$WithVscodePanel,
  [switch]$WithoutVscodePanel,
  [switch]$MigrateLegacy,
  [int]$CapabilityTimeout,
  [string]$ForgeHome,
  [string]$ClaudeHome,
  [string]$CodexHome,
  [string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$nodeArgs = @()
# During updates the installed manifest is authoritative. Passing the parameter's
# legacy default (claude) would silently override a Codex-only installation.
if (-not $Update -or $PSBoundParameters.ContainsKey('Runtime')) {
  $nodeArgs += @('--runtime', $Runtime)
}
if ($DryRun) { $nodeArgs += '--dry-run' }
if ($NoModelProbe) { $nodeArgs += '--no-model-probe' }
if ($WithApp) { $nodeArgs += '--with-app' }
# Both switches are forwarded as given; the Node core refuses the conflict.
if ($WithVscodePanel) { $nodeArgs += '--with-vscode-panel' }
if ($WithoutVscodePanel) { $nodeArgs += '--without-vscode-panel' }
if ($MigrateLegacy) { $nodeArgs += '--migrate-legacy' }
if ($CapabilityTimeout) { $nodeArgs += @('--capability-timeout', $CapabilityTimeout) }
if ($ForgeHome) {
  $forgeHomeArg = $ForgeHome
  if (Test-Path -LiteralPath $ForgeHome) { $forgeHomeArg = (Resolve-Path -LiteralPath $ForgeHome).Path }
  $nodeArgs += @('--forge-home', $forgeHomeArg)
}
if ($ClaudeHome) { $nodeArgs += @('--claude-home', $ClaudeHome) }
if ($CodexHome) { $nodeArgs += @('--codex-home', $CodexHome) }
if ($ProjectRoot) { $nodeArgs += @('--project-root', $ProjectRoot) }

if ($Update) {
  if (-not $DryRun) { $nodeArgs += '--apply' }
  & node (Join-Path $repo 'scripts/forge-update.js') @nodeArgs
} else {
  $nodeArgs = @('--repo', $repo) + $nodeArgs
  & node (Join-Path $repo 'scripts/forge-installer.js') @nodeArgs
}
exit $LASTEXITCODE
