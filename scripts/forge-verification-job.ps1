param([ValidateSet('Compile','Run')][string]$Mode='Run')
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$program=@'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class ForgeVerificationJob {
 [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a,b; public uint flags; public UIntPtr min,max; public uint count; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC basic; public IO io; public UIntPtr a,b,c,d; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct START { public int cb; public string reserved,desktop,title; public uint x,y,xs,ys,xc,yc,fill,flags; public ushort show,reserved2; public IntPtr reservedPtr,stdin,stdout,stderr; }
 [StructLayout(LayoutKind.Sequential)] struct STARTEX { public START start; public IntPtr list; }
 [StructLayout(LayoutKind.Sequential)] struct PROCESS { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct ACCOUNT { public long a,b,c,d; public uint faults,total,active,terminated; }
 [StructLayout(LayoutKind.Sequential)] struct SECURITY { public int size; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
 public class Outcome { public bool started,joined,timedOut,overflow,autoRunDisabled; public int status=127,nativeError; public uint pid,active; public string stdout="",stderr="",reason="job-start-failed"; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref EXT data,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out ACCOUNT data,uint size,IntPtr returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint exit);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr bytes);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr key,IntPtr value,IntPtr bytes,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTEX start,out PROCESS process);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string file,uint access,uint share,ref SECURITY sa,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileSizeEx(IntPtr file,out long bytes);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static void Check(bool ok,string step) { if(!ok)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),step); }
 static bool Valid(IntPtr handle) { return handle!=IntPtr.Zero&&handle!=(IntPtr)(-1); }
 static IntPtr Open(string path,uint access,uint creation,uint flags) {
  SECURITY sa=new SECURITY();sa.size=Marshal.SizeOf(typeof(SECURITY));sa.inherit=true;
  IntPtr h=CreateFile(path,access,7,ref sa,creation,flags,IntPtr.Zero);
  if(!Valid(h))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"stdio");return h;
 }
 static long Length(IntPtr file) { long n;Check(GetFileSizeEx(file,out n),"output-size");return n; }
 static uint Active(IntPtr job) { ACCOUNT info;Check(QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero),"job-query");return info.active; }
 static bool Join(IntPtr job,int limit) { Stopwatch watch=Stopwatch.StartNew();do { if(Active(job)==0)return true;System.Threading.Thread.Sleep(10); }while(watch.ElapsedMilliseconds<limit);return false; }
 static string Read(IntPtr handle,int cap) {
  using(var stream=new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(handle,false),FileAccess.ReadWrite)) {
   long length=stream.Length;int size=(int)Math.Min(length,cap);byte[] bytes=new byte[size];stream.Position=0;
   int head=length>cap?size/2:size,offset=0;while(offset<head) { int n=stream.Read(bytes,offset,head-offset);if(n==0)break;offset+=n; }
   if(length>cap) { stream.Position=length-(size-head);offset=head;while(offset<size){int n=stream.Read(bytes,offset,size-offset);if(n==0)break;offset+=n;} }
   return Convert.ToBase64String(bytes);
  }
 }
 public static Outcome Run(string command,string cwd,int timeout,int maxOutput,string name) {
  return Run(command,cwd,timeout,maxOutput,name,false);
 }
 public static Outcome Run(string command,string cwd,int timeout,int maxOutput,string name,bool disableAutoRun) {
  Outcome result=new Outcome();IntPtr job=IntPtr.Zero,list=IntPtr.Zero,jobs=IntPtr.Zero,handles=IntPtr.Zero,input=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero;PROCESS p=new PROCESS();bool initialized=false;
  result.autoRunDisabled=disableAutoRun;
  try {
   job=CreateJobObject(IntPtr.Zero,name);int creationError=Marshal.GetLastWin32Error();Check(Valid(job),"job-create");
   if(creationError==183)throw new System.ComponentModel.Win32Exception(creationError,"job-name-collision");
   EXT limits=new EXT();limits.basic.flags=0x2000;
   Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXT))),"job-limit");
   input=Open("NUL",0x80000000,3,0);
   string temp=Path.GetTempPath();output=Open(Path.Combine(temp,"forge-verify-"+Guid.NewGuid().ToString("N")+".out"),0xC0000000,1,0x04000100);
   error=Open(Path.Combine(temp,"forge-verify-"+Guid.NewGuid().ToString("N")+".err"),0xC0000000,1,0x04000100);
   IntPtr bytes=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref bytes);list=Marshal.AllocHGlobal(bytes);
   Check(InitializeProcThreadAttributeList(list,2,0,ref bytes),"attributes");initialized=true;
   jobs=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobs,job);
   Check(UpdateProcThreadAttribute(list,0,(IntPtr)0x2000D,jobs,(IntPtr)IntPtr.Size,IntPtr.Zero,IntPtr.Zero),"atomic-job-list");
   handles=Marshal.AllocHGlobal(3*IntPtr.Size);Marshal.WriteIntPtr(handles,0,input);Marshal.WriteIntPtr(handles,IntPtr.Size,output);Marshal.WriteIntPtr(handles,2*IntPtr.Size,error);
   Check(UpdateProcThreadAttribute(list,0,(IntPtr)0x20002,handles,(IntPtr)(3*IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"stdio-handle-list");
   STARTEX start=new STARTEX();start.start.cb=Marshal.SizeOf(typeof(STARTEX));start.start.flags=0x100;start.start.stdin=input;start.start.stdout=output;start.start.stderr=error;start.list=list;
   string app=Path.Combine(Environment.SystemDirectory,"cmd.exe");
   // /s removes only our outer quotes, preserving quoted executable/argument
   // paths inside the original command. /d is an explicit per-call capability;
   // the legacy default keeps its existing AutoRun policy.
   Check(CreateProcess(app,new StringBuilder("\""+app+"\" "+(disableAutoRun?"/d ":"")+"/s /c \""+command+"\""),IntPtr.Zero,IntPtr.Zero,true,0x08080000,IntPtr.Zero,cwd,ref start,out p),"atomic-create");
   result.started=true;result.pid=p.pid;Stopwatch timer=Stopwatch.StartNew();
   for(;;) {
    result.active=Active(job);if(result.active==0) { result.joined=true;break; }
    if(Length(output)>maxOutput||Length(error)>maxOutput) { result.overflow=true;result.reason="output-limit";break; }
    if(timer.ElapsedMilliseconds>=timeout) { result.timedOut=true;result.reason="command-timeout";break; }
    System.Threading.Thread.Sleep(10);
   }
   if(Length(output)>maxOutput||Length(error)>maxOutput) { result.overflow=true;result.reason="output-limit"; }
   if(!result.joined) { Check(TerminateJobObject(job,124),"job-terminate");result.joined=Join(job,10000);result.active=Active(job); }
   if(!result.joined) { result.reason="job-join-unproved";return result; }
   uint code;Check(GetExitCodeProcess(p.process,out code),"exit-code");result.status=unchecked((int)code);
   result.stdout=Read(output,maxOutput);result.stderr=Read(error,maxOutput);
   if(!result.timedOut&&!result.overflow)result.reason="joined";
  }catch(System.ComponentModel.Win32Exception e) { result.nativeError=e.NativeErrorCode;result.reason=result.started?"job-supervision-failed":"job-start-failed"; }
  catch { result.reason=result.started?"job-supervision-failed":"job-start-failed"; }
  finally {
   if(!result.started)result.joined=true;
   else if(!result.joined&&Valid(job)) { try { if(TerminateJobObject(job,124)) { result.joined=Join(job,10000);result.active=Active(job); } }catch { result.joined=false; } }
   if(Valid(p.thread))CloseHandle(p.thread);if(Valid(p.process))CloseHandle(p.process);
   if(initialized)DeleteProcThreadAttributeList(list);if(list!=IntPtr.Zero)Marshal.FreeHGlobal(list);if(jobs!=IntPtr.Zero)Marshal.FreeHGlobal(jobs);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);
   if(Valid(input))CloseHandle(input);if(Valid(output))CloseHandle(output);if(Valid(error))CloseHandle(error);if(Valid(job))CloseHandle(job);
  }
  return result;
 }
}
'@
try {
 if($Mode -eq 'Compile') {
  $compiler=New-Object Microsoft.CSharp.CSharpCodeProvider
  $parameters=New-Object System.CodeDom.Compiler.CompilerParameters
  $parameters.GenerateExecutable=$false
  $parameters.GenerateInMemory=$false
  $parameters.ReferencedAssemblies.Add('System.dll') | Out-Null
  $buildRoot=Join-Path ([IO.Path]::GetTempPath()) ('forge-verifier-build-'+[Guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($buildRoot) | Out-Null
  $parameters.OutputAssembly=Join-Path $buildRoot 'supervisor.dll'
  $parameters.TempFiles=New-Object System.CodeDom.Compiler.TempFileCollection($buildRoot,$false)
  try {
   $compiled=$compiler.CompileAssemblyFromSource($parameters,$program)
   if($compiled.Errors.HasErrors) { throw 'compile-failed' }
   @{schema=1;assembly=[Convert]::ToBase64String([IO.File]::ReadAllBytes($parameters.OutputAssembly))} | ConvertTo-Json -Compress
  } finally {
   $compiler.Dispose()
   $expected=[IO.Path]::GetFullPath($buildRoot)
   if($expected.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and ([IO.Path]::GetFileName($expected) -match '^forge-verifier-build-[a-f0-9]{32}$')) {
    foreach($item in Get-ChildItem -LiteralPath $expected -Force) { if(-not $item.PSIsContainer) { Remove-Item -LiteralPath $item.FullName -Force } }
    [IO.Directory]::Delete($expected)
   }
  }
 } else {
  $packet=[Console]::In.ReadToEnd() | ConvertFrom-Json
  [Reflection.Assembly]::Load([Convert]::FromBase64String($packet.assembly)) | Out-Null
  $disableAutoRun=$false
  if($packet.PSObject.Properties.Name -contains 'disableAutoRun') {
   if($packet.disableAutoRun -isnot [bool]) { throw 'invalid-autorun-option' }
   $disableAutoRun=$packet.disableAutoRun
  }
  $result=[ForgeVerificationJob]::Run([string]$packet.command,[string]$packet.cwd,[int]$packet.timeout,[int]$packet.maxOutput,[string]$packet.jobName,$disableAutoRun)
  @{schema=1;nonce=$packet.nonce;outcome=$result} | ConvertTo-Json -Depth 3 -Compress
 }
} catch {
 @{schema=1;error='verification-supervisor-failed'} | ConvertTo-Json -Compress
 exit 1
}
