@echo off
REM forge-status — Windows CLI wrapper over scripts/forge-status.js
REM Pure pass-through: the engine accepts flags directly (positional <M-id> +
REM --json/--tokens/--watch/--cwd), so no batch-side translation is needed.
REM Installed to a bin dir on PATH by install.ps1.
setlocal
set "FORGE_ROOT=%FORGE_HOME%"
if not defined FORGE_ROOT set "FORGE_ROOT=%USERPROFILE%\.forge-agent"
set "ENGINE=%FORGE_ROOT%\scripts\forge-status.js"
if not exist "%ENGINE%" (
  echo forge-status: engine nao encontrado em "%ENGINE%". Rode /forge-update.>&2
  exit /b 1
)
node "%ENGINE%" %*
