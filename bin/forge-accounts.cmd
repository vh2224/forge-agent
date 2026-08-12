@echo off
REM forge-accounts — Windows CLI wrapper over scripts/forge-accounts.js
REM Pass-through: the engine's subcommand normalizer accepts `forge-accounts <sub> ...`
REM directly, so no batch-side translation is needed. Installed to a bin dir on PATH
REM by install.ps1.
setlocal
set "FORGE_ROOT=%FORGE_HOME%"
if not defined FORGE_ROOT set "FORGE_ROOT=%USERPROFILE%\.forge-agent"
set "ENGINE=%FORGE_ROOT%\scripts\forge-accounts.js"
if not exist "%ENGINE%" (
  echo forge-accounts: engine nao encontrado em "%ENGINE%". Rode /forge-update.>&2
  exit /b 1
)
node "%ENGINE%" %*
