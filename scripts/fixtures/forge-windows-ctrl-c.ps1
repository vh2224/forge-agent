param(
  [Parameter(Mandatory = $true)]
  [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$stage = 'load-config'
$session = $null
$result = [ordered]@{
  nonce = $null
  pid = $null
  stage = $stage
  event = 'CTRL_C_EVENT'
  event_sent = $false
  win32_error = 0
  exit_code = $null
  timeout = $false
  cleanup_forced = $false
  rollback_pid = $null
  rollback_exit_observed = $false
  error = $null
}

function Publish-JsonAtomic([string]$Path, [object]$Value) {
  $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
  [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Compress -Depth 8), [Text.UTF8Encoding]::new($false))
  [IO.File]::Move($temporary, $Path)
}

try {
  $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($name in @('nonce', 'nodePath', 'benchPath', 'cwd', 'startedPath', 'triggerPath', 'cancelPath', 'resultPath')) {
    if (-not $config.$name -or -not [IO.Path]::IsPathRooted([string]$config.$name) -and $name -ne 'nonce') {
      throw "invalid-config:$name"
    }
  }
  if (-not ($config.argv -is [Array])) { throw 'invalid-config:argv' }
  $result.nonce = [string]$config.nonce

  $stage = 'add-type'
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public sealed class ForgeCtrlCSession : IDisposable {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint CTRL_C_EVENT = 0;
  const uint WAIT_OBJECT_0 = 0;
  const uint WAIT_TIMEOUT = 258;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const int JobObjectExtendedLimitInformation = 9;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
    public int dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AllocConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessW(
    string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
    bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
    ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);

  IntPtr process = IntPtr.Zero;
  IntPtr job = IntPtr.Zero;
  bool exited;
  bool assignedToJob;
  bool disposed;
  public uint ProcessId { get; private set; }
  public int LastError { get; private set; }
  public bool CleanupForced { get; private set; }
  public static uint LastRollbackPid { get; private set; }
  public static bool LastRollbackExitObserved { get; private set; }

  static void Check(bool ok, string operation) {
    if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }
  static string Quote(string value) {
    if (value.Length > 0 && value.IndexOfAny(new char[] {' ', '\t', '"'}) < 0) return value;
    var output = new StringBuilder("\"");
    int slashes = 0;
    foreach (char ch in value) {
      if (ch == '\\') { slashes++; continue; }
      if (ch == '"') { output.Append('\\', slashes * 2 + 1).Append(ch); slashes = 0; continue; }
      output.Append('\\', slashes).Append(ch); slashes = 0;
    }
    output.Append('\\', slashes * 2).Append('"');
    return output.ToString();
  }

  public ForgeCtrlCSession(string nodePath, string[] arguments, string cwd, bool forceAssignFailure) {
    PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
    IntPtr limit = IntPtr.Zero;
    try {
      FreeConsole();
      Check(AllocConsole(), "AllocConsole");
      job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
      var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int size = Marshal.SizeOf(info);
      limit = Marshal.AllocHGlobal(size);
      Marshal.StructureToPtr(info, limit, false);
      Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, limit, (uint)size), "SetInformationJobObject");

      var tokens = new List<string>(); tokens.Add(Quote(nodePath));
      foreach (string argument in arguments) tokens.Add(Quote(argument));
      var commandLine = new StringBuilder(String.Join(" ", tokens));
      var startup = new STARTUPINFO(); startup.cb = Marshal.SizeOf(startup);
      Check(CreateProcessW(nodePath, commandLine, IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED,
        IntPtr.Zero, cwd, ref startup, out pi), "CreateProcessW");
      process = pi.hProcess; ProcessId = pi.dwProcessId;
      if (forceAssignFailure) throw new InvalidOperationException("injected-assign-failure");
      Check(AssignProcessToJobObject(job, process), "AssignProcessToJobObject");
      assignedToJob = true;
      Check(SetConsoleCtrlHandler(IntPtr.Zero, true), "SetConsoleCtrlHandler");
      if (ResumeThread(pi.hThread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");
    } catch {
      if (process != IntPtr.Zero && !assignedToJob) {
        LastRollbackPid = ProcessId;
        if (TerminateProcess(process, 201)) {
          LastRollbackExitObserved = WaitForSingleObject(process, 5000) == WAIT_OBJECT_0;
          exited = LastRollbackExitObserved;
        }
      }
      Dispose();
      throw;
    }
    finally {
      if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
      if (limit != IntPtr.Zero) Marshal.FreeHGlobal(limit);
    }
  }

  public bool HasExited() { return WaitForSingleObject(process, 0) == WAIT_OBJECT_0; }
  public bool SendCtrlC() {
    bool sent = GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0);
    LastError = sent ? 0 : Marshal.GetLastWin32Error();
    return sent;
  }
  public uint WaitAndGetExitCode(uint timeoutMs) {
    uint wait = WaitForSingleObject(process, timeoutMs);
    if (wait == WAIT_TIMEOUT) throw new TimeoutException("post-event-timeout");
    if (wait != WAIT_OBJECT_0) throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject");
    uint code; Check(GetExitCodeProcess(process, out code), "GetExitCodeProcess"); exited = true; return code;
  }
  public void Dispose() {
    if (disposed) return; disposed = true;
    if (process != IntPtr.Zero && !exited && !HasExited()) CleanupForced = true;
    if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
    if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
    SetConsoleCtrlHandler(IntPtr.Zero, false);
    FreeConsole();
  }
}
'@

  $stage = 'create-child'
  $arguments = @([string]$config.benchPath) + @($config.argv | ForEach-Object { [string]$_ })
  $session = [ForgeCtrlCSession]::new(
    [string]$config.nodePath,
    $arguments,
    [string]$config.cwd,
    [bool]$config.forceAssignFailure
  )
  $result.pid = $session.ProcessId
  Publish-JsonAtomic ([string]$config.startedPath) ([ordered]@{ nonce = $result.nonce; pid = $result.pid; stage = 'started' })

  $stage = 'wait-trigger'
  $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$config.triggerTimeoutMs)
  while (-not [IO.File]::Exists([string]$config.triggerPath)) {
    if ([IO.File]::Exists([string]$config.cancelPath)) {
      $cancel = Get-Content -LiteralPath ([string]$config.cancelPath) -Raw -Encoding UTF8 | ConvertFrom-Json
      if ([string]$cancel.nonce -ne $result.nonce -or [uint32]$cancel.pid -ne $result.pid) { throw 'invalid-cancel-binding' }
      $stage = 'cancel-send-event'
      $result.event_sent = $session.SendCtrlC()
      $result.win32_error = $session.LastError
      if (-not $result.event_sent) { throw "cancel-GenerateConsoleCtrlEvent:$($result.win32_error)" }
      $stage = 'cancel-wait-child'
      try { $result.exit_code = $session.WaitAndGetExitCode([uint32]$config.postEventTimeoutMs) }
      catch [TimeoutException] { $result.timeout = $true; throw }
      $stage = 'cancelled-gracefully'
      throw 'controller-cancelled-after-graceful-sigint'
    }
    if ($session.HasExited()) { throw 'child-exit-before-trigger' }
    if ([DateTime]::UtcNow -ge $deadline) { $result.timeout = $true; throw 'trigger-timeout' }
    Start-Sleep -Milliseconds 20
  }
  $trigger = Get-Content -LiteralPath ([string]$config.triggerPath) -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$trigger.nonce -ne $result.nonce -or [uint32]$trigger.pid -ne $result.pid) { throw 'invalid-trigger-binding' }

  $stage = 'send-event'
  $result.event_sent = $session.SendCtrlC()
  $result.win32_error = $session.LastError
  if (-not $result.event_sent) { throw "GenerateConsoleCtrlEvent:$($result.win32_error)" }

  $stage = 'wait-child'
  try { $result.exit_code = $session.WaitAndGetExitCode([uint32]$config.postEventTimeoutMs) }
  catch [TimeoutException] { $result.timeout = $true; throw }
  $stage = 'complete'
} catch {
  $result.error = $_.Exception.Message
} finally {
  if ($session) {
    $session.Dispose()
    $result.cleanup_forced = $session.CleanupForced
  }
  try {
    $result.rollback_pid = [ForgeCtrlCSession]::LastRollbackPid
    $result.rollback_exit_observed = [ForgeCtrlCSession]::LastRollbackExitObserved
  } catch {
    # Add-Type itself failed; the named stage/error remains authoritative.
  }
  $result.stage = $stage
  if ($config -and $config.resultPath) {
    try { Publish-JsonAtomic ([string]$config.resultPath) $result } catch { Write-Error "publish-result:$($_.Exception.Message)" }
  }
}

if ($result.error -or $result.cleanup_forced -or $result.exit_code -ne 130) {
  Write-Error ($result | ConvertTo-Json -Compress -Depth 8)
  exit 1
}
exit 0
