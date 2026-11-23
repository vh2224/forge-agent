'use strict';

// Process-family proof for the supervised transport spawn (issue 440, S02/T02).
//
// Only CUSTODY_METHOD can ever answer `stopped`. On win32 the module spawns a
// fixed native supervisor (System32 Windows PowerShell hosting an assembly that
// is compiled once per process by the runtime csc and kept only in memory). The
// supervisor creates a named Job Object with KILL_ON_JOB_CLOSE and no breakaway,
// creates the transport root already INSIDE it (atomic PROC_THREAD_ATTRIBUTE_JOB_LIST,
// suspended, PROC_THREAD_ATTRIBUTE_HANDLE_LIST limited to the three stdio ends),
// journals `custody-established` and only then resumes the root. Membership is
// kept by the kernel from creation; it never depends on samples.
//
// A `stopped` answer additionally needs the LIVE origin registered in this process
// by startAttemptTree (the real ChildProcess and the supervisor lines received on
// a private pipe that only that supervisor holds) plus a current native kernel
// observation. A record or journal read from disk, a PID, a hash or a claimed
// KILL_ON_JOB_CLOSE never prove anything alone: after a restart the answer is
// `unknown`. CENSUS_METHOD (sampled process table) is diagnostic only and yields
// `alive` or `unknown`. This is not an OS sandbox: processes started by system
// intermediaries (WMI, services, scheduler, COM activation) are not descendants,
// and an actor in control of the host can duplicate handles.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const CUSTODY_METHOD = 'process-tree-custody-v1';
const CENSUS_METHOD = 'process-tree-census-v1';
const RECORD_VERSION = 'process-tree-record-v1';
const REASON_CODES = Object.freeze([
  'process-tree-unavailable', 'process-tree-record-missing', 'process-tree-record-invalid',
  'process-tree-binding-mismatch', 'process-tree-root-unbound', 'process-tree-survivors',
  'process-tree-custody-unavailable', 'process-tree-custody-failed', 'process-tree-custody-unproved',
  'process-tree-census-only',
]);
const LIMITS = Object.freeze({
  record_bytes: 256 * 1024, journal_bytes: 64 * 1024, line_bytes: 4096, part_chars: 30000,
  packet_chars: 1024 * 1024, command_line_chars: 32766, cwd_chars: 259, identities: 64, samples: 32,
  observe_timeout_ms: 15000, snapshot_timeout_ms: 15000, snapshot_bytes: 8 * 1024 * 1024,
  snapshot_rows: 65536, compile_timeout_ms: 30000, probe_timeout_ms: 20000, ctrl_wait_ms: 3000,
});
const DEFAULT_SAMPLE_INTERVAL_MS = 30000;
const RESERVED_EXIT = 1179669571;
const JOB_FLAGS = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE only: no BREAKAWAY_OK/SILENT_BREAKAWAY_OK
const ZERO = '0'.repeat(64);
const HEX64 = /^[a-f0-9]{64}$/;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = value => sha(JSON.stringify(value));

class ProcessTreeError extends Error {
  constructor(code) { super(code); this.name = 'ProcessTreeError'; this.code = code; }
}
function fail(code) {
  if (!REASON_CODES.includes(code)) code = 'process-tree-record-invalid';
  throw new ProcessTreeError(code);
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// ── Embedded native supervisor ──────────────────────────────────────────────
// C# 5 only (the .NET Framework csc); references are fixed to mscorlib/System.
const CSHARP = String.raw`using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public static class ForgeProcessTree {
 public const int Reserved=1179669571;
 public class Result { public int Code; public string Output; }
 class Failure : Exception { public string Stage; public int Error; public Failure(string stage,int error){Stage=stage;Error=error;} }
 [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a,b; public uint flags; public UIntPtr min,max; public uint count; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC basic; public IOC io; public UIntPtr a,b,c,d; }
 [StructLayout(LayoutKind.Sequential)] struct ACCOUNT { public long a,b,c,d; public uint faults,total,active,terminated; }
 [StructLayout(LayoutKind.Sequential)] struct START { public int cb; public IntPtr reserved,desktop,title; public uint x,y,xs,ys,xc,yc,fill,flags; public ushort show,cbReserved2; public IntPtr lpReserved2,stdin,stdout,stderr; }
 [StructLayout(LayoutKind.Sequential)] struct STARTEX { public START start; public IntPtr list; }
 [StructLayout(LayoutKind.Sequential)] struct PROCESS { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct FILEINFO { public uint attributes,c1,c2,a1,a2,w1,w2,serial,sizeHigh,sizeLow,links,indexHigh,indexLow; }
 delegate bool CtrlHandler(uint kind);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr sa,string name);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObjectW(uint access,bool inherit,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref EXT data,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out EXT data,uint size,IntPtr returned);
 [DllImport("kernel32.dll",EntryPoint="QueryInformationJobObject",SetLastError=true)] static extern bool QueryAccount(IntPtr job,int kind,out ACCOUNT data,uint size,IntPtr returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr bytes);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr key,IntPtr value,IntPtr bytes,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTEX start,out PROCESS process);
 [DllImport("kernel32.dll",EntryPoint="CreateProcessW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreatePlain(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref START start,out PROCESS process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ProcessIdToSessionId(uint pid,out uint session);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,out uint value,uint size,out uint returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetHandleInformation(IntPtr handle,out uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern void GetStartupInfoW(out START info);
 [DllImport("kernel32.dll")] static extern bool SetStdHandle(int which,IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string file,uint access,uint share,IntPtr sa,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file,out FILEINFO info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(IntPtr file,byte[] buffer,uint count,out uint written,IntPtr overlapped);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(IntPtr file);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetConsoleCtrlHandler(CtrlHandler handler,bool add);
 static readonly CtrlHandler Ignore=new CtrlHandler(IgnoreEvent);
 static bool IgnoreEvent(uint kind){return true;}
 static uint ExtSize{get{return (uint)Marshal.SizeOf(typeof(EXT));}}
 static uint AccountSize{get{return (uint)Marshal.SizeOf(typeof(ACCOUNT));}}
 static bool Valid(IntPtr h){return h!=IntPtr.Zero&&h!=new IntPtr(-1);}
 static Failure Fail(string stage){return new Failure(stage,Marshal.GetLastWin32Error());}
 static string Sha(byte[] bytes){using(SHA256 h=SHA256.Create()){byte[] d=h.ComputeHash(bytes);StringBuilder s=new StringBuilder(64);foreach(byte x in d)s.Append(x.ToString("x2"));return s.ToString();}}
 static bool Hex(string value,int length){if(value==null||value.Length!=length)return false;foreach(char c in value)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return false;return true;}
 static long Created(IntPtr process){long c,e,k,u;return GetProcessTimes(process,out c,out e,out k,out u)?c:0;}
 static long SessionOf(uint pid){uint s;return ProcessIdToSessionId(pid,out s)?(long)s:-1;}
 static int AppContainer(){IntPtr t;if(!OpenProcessToken(GetCurrentProcess(),8,out t))return -1;try{uint v,r;return GetTokenInformation(t,29,out v,4,out r)?(v!=0?1:0):-1;}finally{CloseHandle(t);}}
 static uint Active(IntPtr job){ACCOUNT a;return QueryAccount(job,1,out a,AccountSize,IntPtr.Zero)?a.active:uint.MaxValue;}
 static bool Join(IntPtr job,int limit){Stopwatch w=Stopwatch.StartNew();do{if(Active(job)==0)return true;System.Threading.Thread.Sleep(10);}while(w.ElapsedMilliseconds<limit);return false;}
 static IntPtr[] Fds(START si){
  if(si.cbReserved2<4||si.lpReserved2==IntPtr.Zero)return new IntPtr[0];
  int count=Marshal.ReadInt32(si.lpReserved2);
  if(count<0||count>64||4+count+count*IntPtr.Size>si.cbReserved2)return new IntPtr[0];
  IntPtr[] r=new IntPtr[count];
  for(int i=0;i<count;i++)r[i]=Marshal.ReadIntPtr(si.lpReserved2,4+count+i*IntPtr.Size);
  return r;
 }
 class Attr {
  public IntPtr List,Jobs,Handles;bool init;
  public void Build(IntPtr job,IntPtr[] inherit){
   IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
   List=Marshal.AllocHGlobal(size);
   if(!InitializeProcThreadAttributeList(List,2,0,ref size))throw Fail("attributes");init=true;
   Jobs=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(Jobs,job);
   if(!UpdateProcThreadAttribute(List,0,(IntPtr)0x2000D,Jobs,(IntPtr)IntPtr.Size,IntPtr.Zero,IntPtr.Zero))throw Fail("atomic-job-list");
   Handles=Marshal.AllocHGlobal(inherit.Length*IntPtr.Size);
   for(int i=0;i<inherit.Length;i++)Marshal.WriteIntPtr(Handles,i*IntPtr.Size,inherit[i]);
   if(!UpdateProcThreadAttribute(List,0,(IntPtr)0x20002,Handles,(IntPtr)(inherit.Length*IntPtr.Size),IntPtr.Zero,IntPtr.Zero))throw Fail("stdio-handle-list");
  }
  public void Free(){if(init)DeleteProcThreadAttributeList(List);init=false;if(List!=IntPtr.Zero)Marshal.FreeHGlobal(List);if(Jobs!=IntPtr.Zero)Marshal.FreeHGlobal(Jobs);if(Handles!=IntPtr.Zero)Marshal.FreeHGlobal(Handles);List=Jobs=Handles=IntPtr.Zero;}
 }
 class Journal {
  IntPtr file=IntPtr.Zero,ctrl;int seq;string prev=new string('0',64);public bool Failed;
  public Journal(IntPtr control){ctrl=control;}
  public int Open(string path){
   IntPtr h=CreateFileW(path,0x40000000,1,IntPtr.Zero,1,0x80,IntPtr.Zero);
   if(!Valid(h)){int e=Marshal.GetLastWin32Error();return e==0?1:e;}
   FILEINFO info;
   if(!GetFileInformationByHandle(h,out info)||info.links!=1||(info.attributes&0x400)!=0){CloseHandle(h);return 1;}
   file=h;return 0;
  }
  public void Write(string body){
   byte[] b=Encoding.UTF8.GetBytes("{\"seq\":"+seq+",\"prev\":\""+prev+"\","+body+"}\n");uint n;
   if(Valid(file)){if(!WriteFile(file,b,(uint)b.Length,out n,IntPtr.Zero)||n!=(uint)b.Length||!FlushFileBuffers(file))Failed=true;}else Failed=true;
   if(Valid(ctrl)){if(!WriteFile(ctrl,b,(uint)b.Length,out n,IntPtr.Zero)||n!=(uint)b.Length)Failed=true;}else Failed=true;
   prev=Sha(b);seq++;
  }
  public void Close(){if(Valid(file))CloseHandle(file);file=IntPtr.Zero;if(Valid(ctrl))CloseHandle(ctrl);ctrl=IntPtr.Zero;}
 }
 static string FailedBody(string stage,int error){return "\"event\":\"custody-failed\",\"stage\":\""+stage+"\",\"native_error\":"+error+",\"root_started\":0";}
 static STARTEX Startup(IntPtr list,IntPtr input,IntPtr output,IntPtr error,bool hide){
  STARTEX s=new STARTEX();s.start.cb=Marshal.SizeOf(typeof(STARTEX));s.start.flags=0x101;s.start.show=(ushort)(hide?0:10);
  s.start.stdin=input;s.start.stdout=output;s.start.stderr=error;s.list=list;return s;
 }
 public static Result Entry(string packet){
  Result r=new Result();r.Code=Reserved;
  string[] parts=packet.Split('.');string[] f=new string[parts.Length];
  for(int i=0;i<parts.Length;i++)f[i]=Encoding.UTF8.GetString(Convert.FromBase64String(parts[i]));
  if(f.Length<2||f[0]!="1")return r;
  if(f[1]=="supervise"&&f.Length==11){r.Code=Supervise(f,Sha(Encoding.UTF8.GetBytes(packet)));return r;}
  if(f[1]=="observe"&&f.Length==4){r.Output=Observe(f[2],f[3]);r.Code=0;return r;}
  if(f[1]=="probe"&&f.Length==3){r.Output=Probe(f[2]);r.Code=0;return r;}
  if(f[1]=="breakaway"&&f.Length==4){r.Output=Breakaway(f[2],f[3]);r.Code=0;return r;}
  return r;
 }
 static int Supervise(string[] f,string packetSha){
  string nonce=f[2],jobName=f[3],journalPath=f[4],app=f[5],command=f[6],cwd=f[7],env=f[8],flags=f[9],bindingSha=f[10];
  START si;GetStartupInfoW(out si);IntPtr[] fds=Fds(si);
  Journal j=new Journal(fds.Length>3?fds[3]:IntPtr.Zero);
  if(!Hex(nonce,32)||!Hex(bindingSha,64)||jobName!="Local\\ForgeProcessTree-"+nonce||flags.Length!=4||fds.Length<6){j.Write(FailedBody("packet",0));j.Close();return Reserved;}
  SetConsoleCtrlHandler(Ignore,true);
  uint self=GetCurrentProcessId();
  int opened=j.Open(journalPath);
  if(opened!=0){j.Write(FailedBody("journal",opened));j.Close();return Reserved;}
  j.Write("\"event\":\"supervisor-started\",\"nonce\":\""+nonce+"\",\"packet_sha256\":\""+packetSha+"\",\"binding_sha256\":\""+bindingSha+"\",\"supervisor_pid\":"+self+",\"supervisor_created\":\""+Created(GetCurrentProcess())+"\",\"session\":"+SessionOf(self)+",\"appcontainer\":"+AppContainer());
  bool hide=flags[0]=='h';
  IntPtr input=fds[0],output=flags[2]=='p'?fds[4]:fds[1],error=flags[3]=='p'?fds[5]:fds[2];
  IntPtr job=IntPtr.Zero,envBlock=IntPtr.Zero;PROCESS p=new PROCESS();Attr attr=new Attr();bool resumed=false;int code=Reserved;
  try{
   job=CreateJobObjectW(IntPtr.Zero,jobName);int err=Marshal.GetLastWin32Error();
   if(!Valid(job)){job=IntPtr.Zero;throw new Failure("job-create",err);}
   if(err==183)throw new Failure("job-collision",183);
   EXT limits=new EXT();limits.basic.flags=0x2000;
   if(!SetInformationJobObject(job,9,ref limits,ExtSize))throw Fail("job-limit");
   EXT back;if(!QueryInformationJobObject(job,9,out back,ExtSize,IntPtr.Zero))throw Fail("job-reread");
   if(back.basic.flags!=0x2000)throw new Failure("job-limit-mismatch",0);
   uint hf;if(!GetHandleInformation(job,out hf))throw Fail("job-handle");
   if((hf&1)!=0)throw new Failure("job-handle-inheritable",0);
   IntPtr[] std=new IntPtr[]{input,output,error};
   foreach(IntPtr h in std){if(!Valid(h))throw new Failure("stdio",6);if(!SetHandleInformation(h,1,1))throw Fail("stdio");}
   attr.Build(job,std);
   envBlock=Marshal.StringToHGlobalUni(env.Length==0?"\0":env);
   STARTEX start=Startup(attr.List,input,output,error,hide);
   uint create=0x4|0x80000|0x400|(hide?0x08000000u:0u);
   if(!CreateProcessW(app,new StringBuilder(command,command.Length+1),IntPtr.Zero,IntPtr.Zero,true,create,envBlock,cwd,ref start,out p))throw Fail("root-create");
   bool inJob;if(!IsProcessInJob(p.process,job,out inJob))throw Fail("in-job");
   if(!inJob)throw new Failure("in-job",0);
   long rootCreated=Created(p.process);if(rootCreated==0)throw Fail("root-identity");
   uint active=Active(job);
   j.Write("\"event\":\"custody-established\",\"job_flags\":"+back.basic.flags+",\"job_handle_inheritable\":0,\"root_pid\":"+p.pid+",\"root_created\":\""+rootCreated+"\",\"in_job\":1,\"active\":"+active);
   if(j.Failed)throw new Failure("journal",0);
   // The supervisor keeps no copy of the transport ends: EOF and broken-pipe
   // semantics belong to the root and its members alone.
   CloseHandle(fds[0]);SetStdHandle(-10,IntPtr.Zero);
   if(flags[2]=='p')CloseHandle(fds[4]);
   if(flags[3]=='p')CloseHandle(fds[5]);
   if(ResumeThread(p.thread)==0xFFFFFFFF)throw Fail("resume");
   resumed=true;
   WaitForSingleObject(p.process,0xFFFFFFFF);
   uint exit=1;GetExitCodeProcess(p.process,out exit);
   j.Write("\"event\":\"root-exited\",\"exit_code\":"+exit);
   uint survivors=Active(job);
   if(survivors>0&&survivors!=uint.MaxValue)TerminateJobObject(job,1);
   bool empty=Join(job,10000);ACCOUNT acc;bool counted=QueryAccount(job,1,out acc,AccountSize,IntPtr.Zero);
   j.Write("\"event\":\""+(empty&&counted?"family-empty":"family-unproved")+"\",\"active\":"+(counted?acc.active:0)+",\"total\":"+(counted?acc.total:0)+",\"terminated\":"+(counted?acc.terminated:0)+",\"survivors\":"+(survivors==uint.MaxValue?0:survivors));
   code=unchecked((int)exit);
  }catch(Exception x){
   Failure failure=x as Failure;string stage=failure!=null?failure.Stage:"internal";int native=failure!=null?failure.Error:0;
   if(resumed){if(Valid(job))TerminateJobObject(job,1);j.Write("\"event\":\"family-unproved\",\"active\":0,\"total\":0,\"terminated\":0,\"survivors\":0");}
   else{if(Valid(p.process)){TerminateProcess(p.process,unchecked((uint)Reserved));WaitForSingleObject(p.process,5000);}j.Write(FailedBody(stage,native));}
   code=Reserved;
  }finally{
   attr.Free();if(envBlock!=IntPtr.Zero)Marshal.FreeHGlobal(envBlock);
   if(Valid(p.thread))CloseHandle(p.thread);if(Valid(p.process))CloseHandle(p.process);
   if(Valid(job))CloseHandle(job);j.Close();
  }
  return code;
 }
 // Immediate exit with the exact code: the CLR shutdown path of Environment.Exit
 // costs seconds in Windows PowerShell and could still touch host streams.
 public static void Quit(int code){TerminateProcess(GetCurrentProcess(),unchecked((uint)code));}
 public static IntPtr OpenQuery(string name){IntPtr h=OpenJobObjectW(4,false,name);return Valid(h)?h:IntPtr.Zero;}
 public static void Release(IntPtr handle){if(Valid(handle))CloseHandle(handle);}
 static string Observe(string name,string ids){
  uint self=GetCurrentProcessId();StringBuilder o=new StringBuilder();IntPtr job=IntPtr.Zero;
  o.Append("{\"session\":").Append(SessionOf(self)).Append(",\"appcontainer\":").Append(AppContainer());
  try{
   if(name.Length>0){
    job=OpenJobObjectW(4,false,name);int err=Marshal.GetLastWin32Error();
    if(!Valid(job)){job=IntPtr.Zero;o.Append(",\"job\":\"").Append(err==2?"absent":err==5?"denied":"error").Append("\",\"job_error\":").Append(err);}
    else{ACCOUNT a;EXT e;
     if(QueryAccount(job,1,out a,AccountSize,IntPtr.Zero)&&QueryInformationJobObject(job,9,out e,ExtSize,IntPtr.Zero))o.Append(",\"job\":\"open\",\"active\":").Append(a.active).Append(",\"total\":").Append(a.total).Append(",\"terminated\":").Append(a.terminated).Append(",\"flags\":").Append(e.basic.flags);
     else o.Append(",\"job\":\"error\",\"job_error\":").Append(Marshal.GetLastWin32Error());}
   }else o.Append(",\"job\":\"none\"");
   o.Append(",\"ids\":[");string[] rows=ids.Length>0?ids.Split(';'):new string[0];int written=0;
   for(int i=0;i<rows.Length&&i<256;i++){
    string[] kv=rows[i].Split(':');uint pid;long expected;
    if(kv.Length!=2||!uint.TryParse(kv[0],out pid)||!long.TryParse(kv[1],out expected))continue;
    IntPtr h=OpenProcess(0x1000|0x100000,false,pid);int err=Marshal.GetLastWin32Error();string state;long actual=0;int member=-1;
    if(!Valid(h))state=err==87?"absent":err==5?"denied":"error";
    else{try{actual=Created(h);
     if(actual==0)state="error";else if(expected!=0&&actual!=expected)state="reused";
     else{state=WaitForSingleObject(h,0)==0?"exited":"alive";if(Valid(job)){bool b;member=IsProcessInJob(h,job,out b)?(b?1:0):-1;}}
    }finally{CloseHandle(h);}}
    if(written++>0)o.Append(',');
    o.Append("{\"pid\":").Append(pid).Append(",\"state\":\"").Append(state).Append("\",\"created\":\"").Append(actual).Append("\",\"in_job\":").Append(member).Append('}');
   }
   o.Append("]}");
  }finally{if(Valid(job))CloseHandle(job);}
  return o.ToString();
 }
 static string Probe(string name){
  Stopwatch w=Stopwatch.StartNew();IntPtr job=IntPtr.Zero,nul=IntPtr.Zero;PROCESS p=new PROCESS();Attr attr=new Attr();
  try{
   job=CreateJobObjectW(IntPtr.Zero,name);int err=Marshal.GetLastWin32Error();
   if(!Valid(job)){job=IntPtr.Zero;throw new Failure("job-create",err);}
   if(err==183)throw new Failure("job-collision",183);
   EXT limits=new EXT();limits.basic.flags=0x2000;
   if(!SetInformationJobObject(job,9,ref limits,ExtSize))throw Fail("job-limit");
   EXT back;if(!QueryInformationJobObject(job,9,out back,ExtSize,IntPtr.Zero))throw Fail("job-reread");
   if(back.basic.flags!=0x2000)throw new Failure("job-limit-mismatch",0);
   uint hf;if(!GetHandleInformation(job,out hf))throw Fail("job-handle");
   if((hf&1)!=0)throw new Failure("job-handle-inheritable",0);
   nul=CreateFileW("NUL",0xC0000000,3,IntPtr.Zero,3,0,IntPtr.Zero);if(!Valid(nul)){nul=IntPtr.Zero;throw Fail("stdio");}
   if(!SetHandleInformation(nul,1,1))throw Fail("stdio");
   attr.Build(job,new IntPtr[]{nul});
   string app=System.IO.Path.Combine(Environment.SystemDirectory,"cmd.exe");STARTEX s=Startup(attr.List,nul,nul,nul,true);
   if(!CreateProcessW(app,new StringBuilder("\""+app+"\" /d /c exit 0"),IntPtr.Zero,IntPtr.Zero,true,0x4|0x80000|0x400|0x08000000,IntPtr.Zero,Environment.SystemDirectory,ref s,out p))throw Fail("root-create");
   bool inJob;if(!IsProcessInJob(p.process,job,out inJob))throw Fail("in-job");
   if(!inJob)throw new Failure("in-job",0);
   TerminateProcess(p.process,0);WaitForSingleObject(p.process,5000);
   if(!Join(job,5000))throw new Failure("job-join",0);
   CloseHandle(p.thread);CloseHandle(p.process);p=new PROCESS();
   CloseHandle(job);job=IntPtr.Zero;
   IntPtr again=OpenJobObjectW(4,false,name);err=Marshal.GetLastWin32Error();
   if(Valid(again)){CloseHandle(again);throw new Failure("name-retained",0);}
   if(err!=2)throw new Failure("name-check",err);
   return "{\"ok\":1,\"ms\":"+w.ElapsedMilliseconds+"}";
  }catch(Exception x){Failure failure=x as Failure;return "{\"ok\":0,\"stage\":\""+(failure!=null?failure.Stage:"internal")+"\",\"native_error\":"+(failure!=null?failure.Error:0)+"}";}
  finally{if(Valid(p.process)){TerminateProcess(p.process,0);CloseHandle(p.process);}if(Valid(p.thread))CloseHandle(p.thread);attr.Free();if(Valid(nul))CloseHandle(nul);if(Valid(job))CloseHandle(job);}
 }
 // Diagnostic primitive: a member asking CREATE_BREAKAWAY_FROM_JOB must be refused.
 static string Breakaway(string app,string command){
  START s=new START();s.cb=Marshal.SizeOf(typeof(START));PROCESS p;
  if(!CreatePlain(app,new StringBuilder(command,command.Length+1),IntPtr.Zero,IntPtr.Zero,false,0x4|0x01000000|0x08000000,IntPtr.Zero,null,ref s,out p))return "{\"created\":0,\"native_error\":"+Marshal.GetLastWin32Error()+"}";
  bool any;bool asked=IsProcessInJob(p.process,IntPtr.Zero,out any);
  TerminateProcess(p.process,0);CloseHandle(p.thread);CloseHandle(p.process);
  return "{\"created\":1,\"in_any_job\":"+(asked?(any?1:0):-1)+"}";
 }
}
`;

// Fixed PowerShell bootstraps. The variable packet only ever travels in the
// supervisor's environment; the command line is constant and pinned.
const SUPERVISOR_BOOTSTRAP = [
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$code=1179669571",
  "$probeDiag=[Environment]::GetEnvironmentVariable('FORGE_PROCESS_TREE_PROBE_DIAGNOSTIC') -eq '1';[Environment]::SetEnvironmentVariable('FORGE_PROCESS_TREE_PROBE_DIAGNOSTIC',$null);if($probeDiag){[Console]::Error.WriteLine('forge-probe:bootstrap')}",
  "try{$n=[int][Environment]::GetEnvironmentVariable('FORGE_PROCESS_TREE_PARTS');[Environment]::SetEnvironmentVariable('FORGE_PROCESS_TREE_PARTS',$null)",
  "if($n -lt 1 -or $n -gt 256){throw 'parts'}",
  "if($probeDiag){[Console]::Error.WriteLine('forge-probe:parts-read')}",
  "$s=[Text.StringBuilder]::new()",
  "if($probeDiag){[Console]::Error.WriteLine('forge-probe:builder-ready')}",
  "for($i=0;$i -lt $n;$i++){$k='FORGE_PROCESS_TREE_'+$i;[void]$s.Append([Environment]::GetEnvironmentVariable($k));[Environment]::SetEnvironmentVariable($k,$null)}",
  "$t=$s.ToString();$d=$t.IndexOf(':');if($d -lt 1){throw 'packet'}",
  "if($probeDiag){[Console]::Error.WriteLine('forge-probe:packet-ready')}",
  "if($probeDiag){[Console]::Error.WriteLine('forge-probe:assembly-load')}",
  '[void][Reflection.Assembly]::Load([Convert]::FromBase64String($t.Substring(0,$d)))',
  "if($probeDiag){[Console]::Error.WriteLine('forge-probe:native-entry')}",
  '$r=[ForgeProcessTree]::Entry($t.Substring($d+1))',
  "if($probeDiag){[Console]::Error.WriteLine('forge-probe:native-return')}",
  'if($null -ne $r.Output){$o=[Console]::OpenStandardOutput();$b=([Text.UTF8Encoding]::new($false)).GetBytes($r.Output);$o.Write($b,0,$b.Length);$o.Flush()}',
  '$code=$r.Code;[ForgeProcessTree]::Quit($code)}catch{}',
  'exit $code',
].join('\n');
// Compile pattern of forge-verification-job.ps1 (runtime csc, /noconfig, fixed
// references, no CodeDom, private build directory removed only after join).
const COMPILE_BOOTSTRAP = [
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'",
  'try{',
  "$n=[int][Environment]::GetEnvironmentVariable('FORGE_PROCESS_TREE_PARTS');if($n -lt 1 -or $n -gt 256){throw 'parts'}",
  '$s=New-Object Text.StringBuilder',
  "for($i=0;$i -lt $n;$i++){[void]$s.Append([Environment]::GetEnvironmentVariable('FORGE_PROCESS_TREE_'+$i))}",
  '$program=(New-Object Text.UTF8Encoding($false)).GetString([Convert]::FromBase64String($s.ToString()))',
  '$runtime=[Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()',
  "$compilerPath=[IO.Path]::Combine($runtime,'csc.exe');$coreReference=[IO.Path]::Combine($runtime,'mscorlib.dll');$systemReference=[IO.Path]::Combine($runtime,'System.dll')",
  "foreach($trusted in @($compilerPath,$coreReference,$systemReference)){if(-not [IO.File]::Exists($trusted) -or $trusted.Contains('\"') -or $trusted.Contains([char]0)){throw 'compiler-runtime-unavailable'}}",
  "$buildRoot=[IO.Path]::Combine([IO.Path]::GetTempPath(),'forge-process-tree-build-'+[Guid]::NewGuid().ToString('N'))",
  '[void][IO.Directory]::CreateDirectory($buildRoot)',
  "$sourceFile=[IO.Path]::Combine($buildRoot,'supervisor.cs');$assemblyFile=[IO.Path]::Combine($buildRoot,'supervisor.dll')",
  '$compiler=$null;$compileStarted=$false;$compileJoined=$true;$assembly=$null',
  'try{',
  "if($sourceFile.Contains('\"') -or $assemblyFile.Contains('\"')){throw 'compiler-path-invalid'}",
  '[IO.File]::WriteAllText($sourceFile,$program,(New-Object Text.UTF8Encoding($false)))',
  '$start=New-Object Diagnostics.ProcessStartInfo;$start.FileName=$compilerPath',
  "$start.Arguments=('/noconfig /nologo /target:library /optimize+ /nostdlib+ /reference:\"{0}\" /reference:\"{1}\" /out:\"{2}\" \"{3}\"' -f $coreReference,$systemReference,$assemblyFile,$sourceFile)",
  '$start.WorkingDirectory=$buildRoot;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true',
  "$compiler=New-Object Diagnostics.Process;$compiler.StartInfo=$start;if(-not $compiler.Start()){throw 'compiler-start-failed'}",
  '$compileStarted=$true;$compileJoined=$false',
  '$readers=@(@{stream=$compiler.StandardOutput.BaseStream;buffer=(New-Object byte[] 4096);read=$null;bytes=0},@{stream=$compiler.StandardError.BaseStream;buffer=(New-Object byte[] 4096);read=$null;bytes=0})',
  'foreach($reader in $readers){$reader.read=$reader.stream.ReadAsync($reader.buffer,0,$reader.buffer.Length)}',
  '$watch=[Diagnostics.Stopwatch]::StartNew()',
  'while($true){',
  'foreach($reader in $readers){if($null -ne $reader.read -and $reader.read.IsCompleted){$count=$reader.read.GetAwaiter().GetResult();if($count -eq 0){$reader.read=$null}else{$reader.bytes+=$count;if($reader.bytes -gt 1048576){throw \'compiler-output-limit\'};$reader.read=$reader.stream.ReadAsync($reader.buffer,0,$reader.buffer.Length)}}}',
  'if($compiler.HasExited -and @($readers|Where-Object{$null -ne $_.read}).Count -eq 0){break}',
  "if($watch.ElapsedMilliseconds -ge 20000){throw 'compiler-timeout'}",
  '[Threading.Thread]::Sleep(5)}',
  '$compileJoined=$compiler.WaitForExit(2000)',
  "if(-not $compileJoined -or $compiler.ExitCode -ne 0 -or -not [IO.File]::Exists($assemblyFile)){throw 'compile-failed'}",
  '$assembly=[Convert]::ToBase64String([IO.File]::ReadAllBytes($assemblyFile))',
  '}finally{',
  'if($null -ne $compiler){if($compileStarted -and -not $compileJoined){try{if(-not $compiler.HasExited){$compiler.Kill()};$compileJoined=$compiler.WaitForExit(2000)}catch{$compileJoined=$false}};$compiler.Dispose()}',
  "if(-not $compileJoined){throw 'compiler-join-unproved'}",
  '$expected=[IO.Path]::GetFullPath($buildRoot)',
  "if($expected.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and ([IO.Path]::GetFileName($expected) -match '^forge-process-tree-build-[a-f0-9]{32}$')){foreach($item in [IO.Directory]::GetFiles($expected)){[IO.File]::Delete($item)};[IO.Directory]::Delete($expected)}",
  '}',
  "$o=[Console]::OpenStandardOutput();$b=(New-Object Text.UTF8Encoding($false)).GetBytes('{\"schema\":1,\"assembly\":\"'+$assembly+'\"}');$o.Write($b,0,$b.Length);$o.Flush();exit 0",
  "}catch{$o=[Console]::OpenStandardOutput();$b=(New-Object Text.UTF8Encoding($false)).GetBytes('{\"schema\":1,\"error\":\"compile-failed\"}');$o.Write($b,0,$b.Length);$o.Flush();exit 1}",
].join('\n');
const encoded = script => Buffer.from(script, 'utf16le').toString('base64');
const NATIVE_SOURCE = Object.freeze({ csharp: CSHARP, supervisor: SUPERVISOR_BOOTSTRAP, compile: COMPILE_BOOTSTRAP });
const NATIVE_SHA256 = sha(JSON.stringify([CSHARP, SUPERVISOR_BOOTSTRAP, COMPILE_BOOTSTRAP]));
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const PS_ARGS = script => ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)];
const SUPERVISOR_ARGS = Object.freeze(PS_ARGS(SUPERVISOR_BOOTSTRAP));
const NEUTRAL_CWD = path.dirname(POWERSHELL);
function chunkEnv(text) {
  const env = {}, parts = Math.ceil(text.length / LIMITS.part_chars) || 1;
  for (let i = 0; i < parts; i++) env[`FORGE_PROCESS_TREE_${i}`] = text.slice(i * LIMITS.part_chars, (i + 1) * LIMITS.part_chars);
  env.FORGE_PROCESS_TREE_PARTS = String(parts);
  return env;
}
const b64 = text => Buffer.from(String(text), 'utf8').toString('base64');

// ── Capability: compile once + probe once per process (memory only) ────────
const preparations = new WeakMap();
let defaultPreparation = null;
function collect(command, args, options, timeoutMs) {
  return new Promise(resolve => {
    let child, out = [], err = [], size = 0, errSize = 0, done = false, timer, grace;
    let spawned = false, exited = false, closed = false, timedOut = false, killRequested = false, spawnError = null;
    const outHash = crypto.createHash('sha256'), errHash = crypto.createHash('sha256');
    const errorCode = error => ['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'E2BIG'].includes(error?.code) ? error.code : 'other';
    const finish = status => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(grace);
      resolve({ status: timedOut ? null : status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
        timedOut, spawned, exited, closed, child_joined: closed, kill_requested: killRequested, spawn_error_code: spawnError,
        stdout_bytes: size, stderr_bytes: errSize, stdout_sha256: outHash.digest('hex'), stderr_sha256: errHash.digest('hex') });
    };
    timer = setTimeout(() => {
      timedOut = true;
      try { killRequested = child?.kill() === true; } catch { /* no observed termination */ }
      // A request to kill is not proof of exit. Keep the captured bytes and wait
      // briefly for the actual close; report unknown child join when absent.
      grace = setTimeout(() => finish(null), 1000);
    }, timeoutMs);
    timer.unref?.();
    try { child = cp.spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false }); }
    catch (error) { spawnError = errorCode(error); finish(null); return; }
    child.on('spawn', () => { spawned = true; });
    child.on('error', error => { spawnError = errorCode(error); });
    child.on('exit', () => { exited = true; });
    child.stdout.on('data', chunk => {
      if (done) return;
      outHash.update(chunk); const remaining = Math.max(0, 4 * 1024 * 1024 - size);
      if (remaining) out.push(chunk.subarray(0, remaining)); size += chunk.length;
    });
    child.stderr.on('data', chunk => {
      if (done) return;
      errHash.update(chunk); const remaining = Math.max(0, 16384 - errSize);
      if (remaining) err.push(chunk.subarray(0, remaining)); errSize += chunk.length;
    });
    child.on('close', status => { closed = true; finish(status); });
  });
}
function probeDiagnostic(result, probe) {
  const stages = ['job-create', 'job-collision', 'job-limit', 'job-reread', 'job-limit-mismatch', 'job-handle',
    'job-handle-inheritable', 'stdio', 'attributes', 'atomic-job-list', 'stdio-handle-list', 'root-create',
    'in-job', 'job-join', 'name-retained', 'name-check', 'internal'];
  const markers = String(result.stderr || '').split(/\r?\n/)
    .filter(line => /^forge-probe:(bootstrap|parts-read|builder-ready|packet-ready|assembly-load|native-entry|native-return)$/.test(line)).slice(0, 16);
  // Closed diagnostics only: never expose assembly, environment or raw streams.
  return Object.freeze({ schema_version: 1, timed_out: result.timedOut === true,
    status: Number.isInteger(result.status) ? result.status : null,
    spawn_observed: result.spawned === true, exit_observed: result.exited === true, close_observed: result.closed === true,
    child_joined: result.child_joined === true, descendants_joined: 'not-observed',
    kill_requested: result.kill_requested === true, spawn_error_code: result.spawn_error_code || null,
    stdout_bytes: result.stdout_bytes, stderr_bytes: result.stderr_bytes,
    stdout_sha256: result.stdout_sha256, stderr_sha256: result.stderr_sha256, markers: Object.freeze(markers),
    native_ok: probe?.ok === 1 ? 1 : probe?.ok === 0 ? 0 : null,
    native_stage: stages.includes(probe?.stage) ? probe.stage : null,
    native_error: Number.isInteger(probe?.native_error) ? probe.native_error : null });
}
function nativePacket(assembly, fields) { return `${assembly}:${fields.map(b64).join('.')}`; }
async function prepareFresh(options) {
  const started = Date.now(), timings = {};
  const unavailable = (stage, diagnostic) => Object.freeze({ available: false, reason_code: 'process-tree-custody-unavailable', stage,
    ...(diagnostic ? { probe_diagnostic: diagnostic } : {}),
    timings: Object.freeze({ ...timings, total_ms: Date.now() - started }) });
  if (process.platform !== 'win32') return unavailable('platform');
  try { if (!fs.statSync(POWERSHELL).isFile()) return unavailable('powershell'); } catch { return unavailable('powershell'); }
  const inject = options.inject || null;
  if (inject === 'powershell') return unavailable('powershell');
  const compileEnv = { ...process.env, ...chunkEnv(b64(inject === 'compile' ? CSHARP.replace('public static class ForgeProcessTree {', 'public static class ForgeProcessTree @ {') : CSHARP)) };
  if (typeof options.temp === 'string') Object.assign(compileEnv, { TEMP: options.temp, TMP: options.temp });
  const compileStart = Date.now();
  const compiled = await collect(POWERSHELL, PS_ARGS(COMPILE_BOOTSTRAP), { cwd: NEUTRAL_CWD, env: compileEnv }, LIMITS.compile_timeout_ms);
  timings.compile_ms = Date.now() - compileStart;
  let packet = null;
  try { packet = JSON.parse(compiled.stdout); } catch { packet = null; }
  if (compiled.status !== 0 || packet?.schema !== 1 || typeof packet.assembly !== 'string'
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(packet.assembly) || packet.assembly.length > 2 * 1024 * 1024) return unavailable('compile');
  const assembly = packet.assembly;
  if (inject === 'probe') return unavailable('probe');
  const probeStart = Date.now(), probeJob = `Local\\ForgeProcessTree-probe-${crypto.randomBytes(16).toString('hex')}`;
  const probed = await collect(POWERSHELL, SUPERVISOR_ARGS, { cwd: NEUTRAL_CWD,
    env: { ...chunkEnv(nativePacket(assembly, ['1', 'probe', probeJob])), FORGE_PROCESS_TREE_PROBE_DIAGNOSTIC: '1' } }, LIMITS.probe_timeout_ms);
  timings.probe_ms = Date.now() - probeStart;
  let probe = null;
  try { probe = JSON.parse(probed.stdout); } catch { probe = null; }
  if (probed.status !== 0 || probed.timedOut || !probed.closed || probe?.ok !== 1) return unavailable('probe', probeDiagnostic(probed, probe));
  timings.probe_native_ms = probe.ms;
  const status = Object.freeze({ available: true, reason_code: null, stage: 'ready',
    assembly_sha256: sha(Buffer.from(assembly, 'base64')), assembly_bytes: Buffer.from(assembly, 'base64').length,
    native_sha256: NATIVE_SHA256, timings: Object.freeze({ ...timings, total_ms: Date.now() - started }) });
  return { status, assembly };
}
// Asynchronous warm-up, called by the protected activity before its synchronous
// spawn path. Default preparation is cached in memory for the process lifetime;
// options only ever DEGRADE (failure injection) or move the compiler TEMP.
let defaultHandle = null;
async function prepareCustody(options = {}) {
  const custom = options.inject !== undefined || options.temp !== undefined || options.fresh === true;
  if (!custom && defaultPreparation) return defaultPreparation;
  const run = (async () => {
    let result;
    try { result = await prepareFresh(options); } catch { result = { status: Object.freeze({ available: false, reason_code: 'process-tree-custody-unavailable', stage: 'internal', timings: Object.freeze({}) }) }; }
    if (!result.status) result = { status: result };
    const handle = Object.freeze({ kind: 'process-tree-preparation' });
    preparations.set(handle, { status: result.status, assembly: result.assembly || null });
    if (!custom) defaultHandle = handle;
    return handle;
  })();
  if (!custom) defaultPreparation = run;
  return run;
}
function preparationStatus(handle) {
  const value = preparations.get(handle);
  return value ? value.status : Object.freeze({ available: false, reason_code: 'process-tree-custody-unavailable', stage: 'not-prepared', timings: Object.freeze({}) });
}
function currentPreparation(handle) {
  if (handle !== undefined) return preparations.get(handle) || null;
  return defaultHandle ? preparations.get(defaultHandle) : null;
}
function nativeAssembly(handle) { const value = currentPreparation(handle); return value?.assembly || null; }

// ── libuv parity tables (pure; every platform) ──────────────────────────────
// quote_cmd_arg of libuv src/win/process.c.
function quoteArgument(source) {
  if (source.length === 0) return '""';
  if (!/[ \t"]/.test(source)) return source;
  if (!/["\\]/.test(source)) return `"${source}"`;
  let out = '', quoteHit = true;
  for (let i = source.length; i > 0; --i) {
    const c = source[i - 1];
    out += c;
    if (quoteHit && c === '\\') out += '\\';
    else if (c === '"') { quoteHit = true; out += '\\'; }
    else quoteHit = false;
  }
  return `"${out.split('').reverse().join('')}"`;
}
function commandLine(argv) { return argv.map(quoteArgument).join(' '); }
const REQUIRED_VARS = Object.freeze(['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR']);
function upperName(pair) { return pair.slice(0, pair.indexOf('=')).toUpperCase(); }
function compareNames(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
// Node normalizeSpawnArguments (win32 dedupe) + libuv make_program_env (sorted,
// required variables copied from the parent when absent). null = unsupported form.
function effectiveEnvironment(env, parent = process.env) {
  const source = env || parent, keys = [];
  const coverage = env && parent.NODE_V8_COVERAGE && !Object.prototype.hasOwnProperty.call(env, 'NODE_V8_COVERAGE') ? parent.NODE_V8_COVERAGE : undefined;
  for (const key in source) keys.push(key);
  if (coverage !== undefined && !keys.includes('NODE_V8_COVERAGE')) keys.push('NODE_V8_COVERAGE');
  const seen = new Set(), pairs = [];
  for (const key of keys.sort()) {
    const upper = key.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    const value = key === 'NODE_V8_COVERAGE' && coverage !== undefined ? coverage : source[key];
    if (value === undefined) continue;
    const text = `${value}`;
    if (!key || key.includes('=') || /[^\x20-\x7e]/.test(key) || key.includes('\0') || text.includes('\0')) return null;
    pairs.push(`${key}=${text}`);
  }
  const names = new Set(pairs.map(upperName));
  // GetEnvironmentVariableW of the parent is case-insensitive.
  const parentKeys = Object.keys(parent);
  for (const name of REQUIRED_VARS) {
    if (names.has(name)) continue;
    const key = parentKeys.find(candidate => candidate.toUpperCase() === name);
    const value = key === undefined ? undefined : parent[key];
    if (typeof value === 'string' && value.length) pairs.push(`${name}=${value}`);
  }
  return pairs.sort((a, b) => compareNames(upperName(a), upperName(b)));
}
function envValue(pairs, name) {
  const row = pairs.find(pair => upperName(pair) === name);
  return row === undefined ? undefined : row.slice(row.indexOf('=') + 1);
}
function isFileAt(file, stat) {
  try { const s = stat(file); return s.isFile(); } catch { return false; }
}
// search_path of libuv: cwd first (unless NoDefaultCurrentDirectoryInExePath),
// then PATH of the EFFECTIVE environment; literal (only with an extension), .com, .exe.
function resolveExecutable(file, cwd, pathValue, options = {}) {
  const stat = options.stat || fs.statSync, parent = options.parent || process.env;
  if (typeof file !== 'string' || !file || file === '.' || file.includes('\0') || !path.win32.isAbsolute(cwd)) return null;
  let start = file.length;
  while (start > 0 && !['\\', '/', ':'].includes(file[start - 1])) start--;
  const name = file.slice(start), hasDir = start !== 0;
  const dot = name.indexOf('.'), hasExt = dot >= 0 && dot < name.length - 1;
  const walk = dir => {
    if (/^[A-Za-z]:$/.test(dir) || /^[A-Za-z]:[^\\/]/.test(dir)) return null;
    for (const ext of [...(hasExt ? [''] : []), '.com', '.exe']) {
      const candidate = path.win32.resolve(cwd, dir, `${hasDir ? file : name}${ext}`);
      if (isFileAt(candidate, stat)) return candidate;
    }
    return null;
  };
  if (hasDir) {
    if (/^[A-Za-z]:[^\\/]/.test(file)) return null;
    for (const ext of [...(hasExt ? [''] : []), '.com', '.exe']) {
      const candidate = path.win32.resolve(cwd, `${file}${ext}`);
      if (isFileAt(candidate, stat)) return candidate;
    }
    return null;
  }
  if (parent.NoDefaultCurrentDirectoryInExePath === undefined) {
    const found = walk('');
    if (found) return found;
  }
  for (let rest = typeof pathValue === 'string' ? pathValue : ''; rest.length;) {
    let dir;
    if (rest[0] === '"' || rest[0] === "'") {
      const close = rest.indexOf(rest[0], 1), end = rest.indexOf(';', close < 0 ? 1 : close);
      dir = rest.slice(0, end < 0 ? rest.length : end); rest = end < 0 ? '' : rest.slice(end + 1);
    } else {
      const end = rest.indexOf(';');
      dir = rest.slice(0, end < 0 ? rest.length : end); rest = end < 0 ? '' : rest.slice(end + 1);
    }
    if (!dir) continue;
    if (dir[0] === '"' || dir[0] === "'") dir = dir.slice(1);
    if (dir.endsWith('"') || dir.endsWith("'")) dir = dir.slice(0, -1);
    if (!dir) continue;
    const found = walk(dir);
    if (found) return found;
  }
  return null;
}
function stdioModes(stdio) {
  const list = stdio === undefined || stdio === null ? ['pipe', 'pipe', 'pipe']
    : typeof stdio === 'string' ? [stdio, stdio, stdio] : Array.isArray(stdio) ? [...stdio] : null;
  if (!list || list.length > 3) return null;
  while (list.length < 3) list.push(undefined);
  const modes = list.map(mode => mode === undefined || mode === null ? 'pipe' : mode);
  return modes.every(mode => mode === 'pipe' || mode === 'ignore') ? modes : null;
}
// Decide BEFORE any spawn whether the supervisor reproduces this request with
// fidelity. Anything else keeps the plain spawn (and can never prove stopped).
function planCustody(command, args, options = {}, parent = process.env) {
  const refuse = reason => Object.freeze({ supported: false, reason });
  if (typeof command !== 'string' || !command || command.includes('\0')) return refuse('command');
  if (args !== undefined && !Array.isArray(args)) return refuse('args');
  const argv = [command, ...(args || [])];
  if (argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) return refuse('args');
  if (!options || typeof options !== 'object') return refuse('options');
  for (const key of ['shell', 'detached', 'windowsVerbatimArguments']) if (options[key]) return refuse(key);
  for (const key of ['argv0', 'uid', 'gid', 'signal', 'timeout', 'serialization']) if (options[key] !== undefined) return refuse(key);
  const modes = stdioModes(options.stdio);
  if (!modes) return refuse('stdio');
  const cwd = options.cwd === undefined || options.cwd === null ? process.cwd() : options.cwd;
  if (typeof cwd !== 'string' || !path.win32.isAbsolute(cwd) || cwd.length > LIMITS.cwd_chars || cwd.includes('\0')) return refuse('cwd');
  try { if (!fs.statSync(cwd).isDirectory()) return refuse('cwd'); } catch { return refuse('cwd'); }
  const env = effectiveEnvironment(options.env, parent);
  if (!env) return refuse('env');
  const app = resolveExecutable(command, cwd, envValue(env, 'PATH'), { parent });
  if (!app) return refuse('unresolved');
  if (!/\.(exe|com)$/i.test(app)) return refuse('extension');
  try {
    if (fs.lstatSync(app).isSymbolicLink()) return refuse('link');
    const fd = fs.openSync(app, 'r'), head = Buffer.alloc(2);
    try { if (fs.readSync(fd, head, 0, 2, 0) !== 2 || head.toString('latin1') !== 'MZ') return refuse('image'); } finally { fs.closeSync(fd); }
  } catch { return refuse('image'); }
  const line = commandLine(argv);
  if (line.length > LIMITS.command_line_chars) return refuse('command-line');
  const envBlock = env.length ? `${env.join('\0')}\0` : '';
  return Object.freeze({ supported: true, reason: null, app, commandLine: line, cwd, envBlock, modes: Object.freeze(modes),
    hide: options.windowsHide === true, env_entries: env.length, env_chars: envBlock.length });
}

// ── Census (diagnostic only) ────────────────────────────────────────────────
const CENSUS_SCRIPT = [
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'",
  '$epoch=New-Object DateTime(1970,1,1,0,0,0,[DateTimeKind]::Utc);$w=New-Object Text.StringBuilder',
  "foreach($p in Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate){$c=0;if($null -ne $p.CreationDate){$c=[long][Math]::Floor(($p.CreationDate.ToUniversalTime()-$epoch).TotalMilliseconds)};[void]$w.Append([string]$p.ProcessId+' '+[string]$p.ParentProcessId+' '+[string]$c+\"`n\")}",
  '$o=[Console]::OpenStandardOutput();$b=(New-Object Text.UTF8Encoding($false)).GetBytes($w.ToString());$o.Write($b,0,$b.Length);$o.Flush()',
].join('\n');
function censusCommand(platform) {
  if (platform === 'win32') return { command: POWERSHELL, args: PS_ARGS(CENSUS_SCRIPT) };
  if (platform === 'darwin') return { command: 'ps', args: ['-A', '-o', 'pid=,ppid=,lstart='] };
  return null;
}
function parseCensus(text, platform) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (rows.length >= LIMITS.snapshot_rows) return null;
    const parts = line.trim().split(/\s+/);
    let pid, ppid, started;
    if (platform === 'darwin') {
      [pid, ppid] = parts.map(Number); started = Date.parse(parts.slice(2).join(' '));
    } else { [pid, ppid, started] = parts.map(Number); }
    if (!Number.isSafeInteger(pid) || pid < 0 || !Number.isSafeInteger(ppid) || ppid < 0 || !Number.isFinite(started)) return null;
    rows.push({ pid, ppid, started_ms: Math.floor(started) });
  }
  return rows;
}
function linuxCensus(procRoot = '/proc') {
  const local = require('./forge-sidecar-local-proof');
  const btime = Number(/^btime\s+(\d+)$/m.exec(fs.readFileSync(path.join(procRoot, 'stat'), 'utf8'))?.[1]);
  if (!Number.isSafeInteger(btime)) return null;
  const rows = [];
  for (const name of fs.readdirSync(procRoot).filter(entry => /^\d+$/.test(entry)).slice(0, LIMITS.snapshot_rows)) {
    let text;
    try { text = fs.readFileSync(path.join(procRoot, name, 'stat'), 'utf8'); } catch { continue; }
    const row = local.parseProcStat(text), fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
    const ticks = Number(fields[19]);
    if (row && Number.isSafeInteger(ticks)) rows.push({ pid: row.pid, ppid: row.ppid, started_ms: btime * 1000 + Math.floor(ticks * 1000 / 100) });
  }
  return rows;
}
// snapshot(): never `stopped`. Unavailable/timeout/invalid → process-tree-unavailable.
function snapshot(options = {}) {
  const platform = options.platform || process.platform, started = Date.now();
  const unavailable = () => Object.freeze({ status: 'unavailable', reason_code: 'process-tree-unavailable', method: CENSUS_METHOD, duration_ms: Date.now() - started });
  try {
    let rows;
    if (platform === 'linux' && !options.runner) rows = linuxCensus(options.procRoot);
    else {
      const spec = censusCommand(platform === 'linux' ? 'darwin' : platform);
      if (!spec) return unavailable();
      const runner = options.runner || cp.spawnSync;
      const result = runner(spec.command, spec.args, { cwd: options.cwd || (platform === 'win32' ? NEUTRAL_CWD : '/'), shell: false, windowsHide: true,
        timeout: options.timeoutMs || LIMITS.snapshot_timeout_ms, maxBuffer: LIMITS.snapshot_bytes, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (!result || result.error || result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.length > LIMITS.snapshot_bytes) return unavailable();
      rows = parseCensus(result.stdout, platform);
    }
    if (!rows || !rows.length) return unavailable();
    return deepFreeze({ status: 'ok', reason_code: null, method: CENSUS_METHOD, rows, duration_ms: Date.now() - started });
  } catch { return unavailable(); }
}
function snapshotAsync(platform = process.platform) {
  if (platform !== 'win32') return Promise.resolve(snapshot({ platform }));
  const spec = censusCommand('win32');
  return collect(spec.command, spec.args, { cwd: NEUTRAL_CWD }, LIMITS.snapshot_timeout_ms).then(result => {
    const rows = result.status === 0 ? parseCensus(result.stdout, platform) : null;
    return rows && rows.length ? deepFreeze({ status: 'ok', method: CENSUS_METHOD, rows }) : Object.freeze({ status: 'unavailable', reason_code: 'process-tree-unavailable' });
  });
}
function descendantsOf(rows, rootPid) {
  const root = rows.find(row => row.pid === rootPid);
  if (!root) return [];
  const found = [root], frontier = [root];
  while (frontier.length && found.length < LIMITS.identities) {
    const parent = frontier.shift();
    for (const row of rows) {
      if (row.ppid === parent.pid && row.started_ms >= parent.started_ms && !found.includes(row)) { found.push(row); frontier.push(row); }
    }
  }
  return found.slice(0, LIMITS.identities).map(row => [row.pid, row.started_ms]);
}
// Pure evaluator: registered census identities against one fresh census.
function evaluateCensus(identities, census, rootRunning = false) {
  if (rootRunning) return { status: 'alive', reason_code: 'process-tree-survivors', alive: 1 };
  if (!census || census.status !== 'ok') return { status: 'unknown', reason_code: 'process-tree-unavailable', alive: 0 };
  const live = new Set(census.rows.map(row => `${row.pid}:${row.started_ms}`));
  const alive = identities.filter(([pid, started]) => live.has(`${pid}:${started}`)).length;
  return alive ? { status: 'alive', reason_code: 'process-tree-survivors', alive }
    : { status: 'unknown', reason_code: identities.length ? 'process-tree-census-only' : 'process-tree-custody-unavailable', alive: 0 };
}

// ── Native observer (read-only; same assembly) ──────────────────────────────
let observerRuns = 0;
function runObserver(assembly, jobName, ids, timeoutMs = LIMITS.observe_timeout_ms) {
  if (!assembly || process.platform !== 'win32') return null;
  const started = Date.now();
  observerRuns++;
  try {
    const result = cp.spawnSync(POWERSHELL, SUPERVISOR_ARGS, { cwd: NEUTRAL_CWD, shell: false, windowsHide: true, timeout: timeoutMs,
      maxBuffer: 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      env: chunkEnv(nativePacket(assembly, ['1', 'observe', jobName || '', ids.map(([pid, created]) => `${pid}:${created}`).join(';')])) });
    if (result.error || result.status !== 0) return null;
    const value = JSON.parse(result.stdout);
    if (!value || typeof value !== 'object' || !Array.isArray(value.ids) || !['open', 'absent', 'denied', 'error', 'none'].includes(value.job)) return null;
    value.duration_ms = Date.now() - started;
    return value;
  } catch { return null; }
}
// Diagnostic identity lookup for the live helpers (created '0' = look up).
function identities(rows, handle) {
  const observed = runObserver(nativeAssembly(handle), '', rows.map(row => [row.pid, row.created || '0']));
  return observed ? deepFreeze(observed.ids.map(row => ({ pid: row.pid, state: row.state, created: row.created }))) : null;
}

// ── Exclusive external record (Node) ────────────────────────────────────────
function identityOf(stat) { return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`; }
function statFile(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) fail('process-tree-record-invalid');
  return stat;
}
function readBounded(file, limit) {
  let stat;
  try { stat = fs.lstatSync(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; fail('process-tree-record-invalid'); }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(limit)) fail('process-tree-record-invalid');
  const read = require('./forge-autonomy-sources').readBoundedStableFile(file, limit, { expectedReal: fs.realpathSync.native(file) });
  if (read.error) fail('process-tree-record-invalid');
  const after = statFile(file);
  if (identityOf(after) !== identityOf(stat)) fail('process-tree-record-invalid');
  return { bytes: read.buffer, identity: identityOf(after) };
}
function validateTargets(files, roots) {
  const xllm = require('./forge-xllm');
  for (const file of files) for (const root of roots) {
    try { xllm.validateResultFileTarget(file, root); } catch { fail('process-tree-record-invalid'); }
  }
}
function recordLines(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || !text.endsWith('\n')) fail('process-tree-record-invalid');
  let prev = ZERO;
  return text.slice(0, -1).split('\n').map((line, index) => {
    if (!line || line.includes('\r') || Buffer.byteLength(line) > LIMITS.line_bytes) fail('process-tree-record-invalid');
    let row;
    try { row = JSON.parse(line); } catch { fail('process-tree-record-invalid'); }
    if (!row || typeof row !== 'object' || row.seq !== index || row.prev !== prev || JSON.stringify(row) !== line) fail('process-tree-record-invalid');
    prev = sha(`${line}\n`);
    return row;
  });
}
function createRecord(file, header) {
  const line = Buffer.from(`${JSON.stringify({ seq: 0, prev: ZERO, ...header })}\n`);
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); } catch { fail('process-tree-record-invalid'); }
  try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const stat = statFile(file), read = readBounded(file, LIMITS.record_bytes);
  if (!read.bytes.equals(line)) fail('process-tree-record-invalid');
  return { bytes: line, identity: identityOf(stat), seq: 1, prev: sha(line) };
}
// Prefix (sha256, size, identity) re-proved before and after every append.
function appendRecord(origin, row) {
  const anchor = origin.record;
  const line = Buffer.from(`${JSON.stringify({ seq: anchor.seq, prev: anchor.prev, ...row })}\n`);
  if (line.length > LIMITS.line_bytes || anchor.bytes.length + line.length > LIMITS.record_bytes) fail('process-tree-record-invalid');
  const current = readBounded(origin.recordFile, LIMITS.record_bytes);
  if (!current || !current.bytes.equals(anchor.bytes) || current.identity !== anchor.identity) fail('process-tree-record-invalid');
  const fd = fs.openSync(origin.recordFile, fs.constants.O_WRONLY | fs.constants.O_APPEND);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (identityOf(opened) !== anchor.identity || opened.size !== BigInt(anchor.bytes.length) || opened.nlink !== 1n) fail('process-tree-record-invalid');
    fs.writeSync(fd, line); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const after = readBounded(origin.recordFile, LIMITS.record_bytes), expected = Buffer.concat([anchor.bytes, line]);
  if (!after || !after.bytes.equals(expected) || after.identity !== anchor.identity) fail('process-tree-record-invalid');
  origin.record = { bytes: expected, identity: anchor.identity, seq: anchor.seq + 1, prev: sha(line) };
}
function safeAppend(origin, row) { try { appendRecord(origin, row); return true; } catch { origin.recordBroken = true; return false; } }

// ── Binding ─────────────────────────────────────────────────────────────────
const BINDING_KEYS = Object.freeze(['dispatch_id', 'fingerprint', 'recovery_identity_sha256', 'unit', 'claim_generation', 'lease_generation']);
function validBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false;
  const keys = Object.keys(binding).sort();
  if (keys.length !== BINDING_KEYS.length || BINDING_KEYS.some(key => !keys.includes(key))) return false;
  for (const key of ['dispatch_id', 'fingerprint', 'unit']) if (typeof binding[key] !== 'string' || !binding[key] || binding[key].length > 256) return false;
  if (!HEX64.test(binding.recovery_identity_sha256)) return false;
  for (const key of ['claim_generation', 'lease_generation']) {
    const value = binding[key];
    if (!(value === null || Number.isSafeInteger(value) || (typeof value === 'string' && value.length <= 256))) return false;
  }
  return true;
}
function canonicalBinding(binding) { return Object.fromEntries(BINDING_KEYS.map(key => [key, binding[key]])); }

// ── Origins: private, in-process, never reconstructed from disk ─────────────
const origins = new Map(), spawnErrors = new WeakSet(), custodyFailures = new WeakSet(), proofs = new WeakMap();
function recordKey(file) {
  const parent = fs.realpathSync.native(path.dirname(path.resolve(file)));
  const full = path.join(parent, path.basename(file));
  return process.platform === 'win32' ? full.toLowerCase() : full;
}
const CTRL_EVENTS = Object.freeze({
  'supervisor-started': ['nonce', 'packet_sha256', 'binding_sha256', 'supervisor_pid', 'supervisor_created', 'session', 'appcontainer'],
  'custody-established': ['job_flags', 'job_handle_inheritable', 'root_pid', 'root_created', 'in_job', 'active'],
  'root-exited': ['exit_code'],
  'family-empty': ['active', 'total', 'terminated', 'survivors'],
  'family-unproved': ['active', 'total', 'terminated', 'survivors'],
  'custody-failed': ['stage', 'native_error', 'root_started'],
});
const FAILURE_STAGES = new Set(['packet', 'journal', 'job-create', 'job-collision', 'job-limit', 'job-reread', 'job-limit-mismatch',
  'job-handle', 'job-handle-inheritable', 'stdio', 'attributes', 'atomic-job-list', 'stdio-handle-list', 'root-create', 'in-job', 'root-identity', 'resume', 'internal']);
const uintOk = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xFFFFFFFF;
const ticksOk = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
function validCtrl(origin, row, index) {
  const keys = CTRL_EVENTS[row.event];
  if (!keys) return false;
  const expected = ['seq', 'prev', 'event', ...keys];
  if (Object.keys(row).length !== expected.length || expected.some((key, i) => Object.keys(row)[i] !== key)) return false;
  const events = origin.ctrl.map(item => item.row.event), previous = events.at(-1);
  if (row.event === 'supervisor-started') {
    return index === 0 && row.nonce === origin.nonce && row.packet_sha256 === origin.packetSha && row.binding_sha256 === origin.bindingSha
      && row.supervisor_pid === origin.child.pid && ticksOk(row.supervisor_created) && Number.isSafeInteger(row.session) && [0, 1, -1].includes(row.appcontainer);
  }
  if (row.event === 'custody-failed') {
    return (index === 0 || previous === 'supervisor-started') && FAILURE_STAGES.has(row.stage) && uintOk(row.native_error) && row.root_started === 0;
  }
  if (row.event === 'custody-established') {
    return previous === 'supervisor-started' && row.job_flags === JOB_FLAGS && row.job_handle_inheritable === 0 && uintOk(row.root_pid) && row.root_pid > 0
      && ticksOk(row.root_created) && row.in_job === 1 && uintOk(row.active);
  }
  if (row.event === 'root-exited') return previous === 'custody-established' && uintOk(row.exit_code);
  return ['root-exited', 'custody-established'].includes(previous) && ['active', 'total', 'terminated', 'survivors'].every(key => uintOk(row[key]))
    && (row.event === 'family-unproved' || row.active === 0);
}
function consumeCtrl(origin, chunk) {
  if (origin.ctrlInvalid) return;
  origin.ctrlPending = Buffer.concat([origin.ctrlPending, chunk]);
  if (origin.ctrlPending.length + origin.ctrlBytes.length > LIMITS.journal_bytes) { origin.ctrlInvalid = true; return; }
  for (let at = origin.ctrlPending.indexOf(10); at >= 0; at = origin.ctrlPending.indexOf(10)) {
    const bytes = origin.ctrlPending.subarray(0, at + 1);
    origin.ctrlPending = origin.ctrlPending.subarray(at + 1);
    let row = null;
    try { row = JSON.parse(bytes.toString('utf8')); } catch { row = null; }
    const index = origin.ctrl.length;
    if (!row || row.seq !== index || row.prev !== (index ? sha(origin.ctrl[index - 1].bytes) : ZERO) || !validCtrl(origin, row, index)) { origin.ctrlInvalid = true; return; }
    origin.ctrl.push({ row: deepFreeze(row), bytes: Buffer.from(bytes) });
    origin.ctrlBytes = Buffer.concat([origin.ctrlBytes, bytes]);
    safeAppend(origin, { kind: 'custody', event: row.event, line_sha256: sha(bytes) });
    // An authenticated custody-failed row (validated above against the live nonce,
    // binding and pipe chain; root_started is 0) means no root/provider ever started.
    // Surface it on the consumed child as the same branded failure a spawn-time
    // custody failure throws, never by the reserved exit number alone.
    if (row.event === 'custody-failed' && origin.child && origin.child.listenerCount('error') > 0) {
      const error = new ProcessTreeError('process-tree-custody-failed');
      custodyFailures.add(error);
      origin.child.emit('error', error);
    }
  }
}
function ctrlEvent(origin, name) { return origin.ctrl.find(item => item.row.event === name)?.row || null; }

// ── Spawn ───────────────────────────────────────────────────────────────────
function plainSpawn(command, args, options) {
  try { return cp.spawn(command, args, options); }
  catch (error) { if (error && typeof error === 'object') spawnErrors.add(error); throw error; }
}
function startAttemptTree(input = {}) {
  const { command, args, options = {}, resultFile, binding, roots } = input;
  if (typeof resultFile !== 'string' || !path.isAbsolute(resultFile) || !validBinding(binding)
      || !Array.isArray(roots) || !roots.length || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) fail('process-tree-record-invalid');
  const recordFile = `${resultFile}.process-tree.jsonl`, journalFile = `${resultFile}.process-tree.custody.jsonl`;
  validateTargets([recordFile, journalFile], roots);
  for (const file of [recordFile, journalFile]) { try { fs.lstatSync(file); fail('process-tree-record-invalid'); } catch (error) { if (error instanceof ProcessTreeError) throw error; } }
  const key = recordKey(recordFile);
  if (origins.has(key)) fail('process-tree-record-invalid');
  const preparation = currentPreparation(input.preparation);
  const plan = process.platform === 'win32' ? planCustody(command, args, options) : Object.freeze({ supported: false, reason: 'platform' });
  const nonce = crypto.randomBytes(16).toString('hex'), jobName = `Local\\ForgeProcessTree-${nonce}`;
  const fixed = canonicalBinding(binding), bindingSha = digest(fixed);
  let mode = plan.supported && preparation?.assembly ? 'custody' : 'census-only';
  let packetText = null, packetSha = null;
  if (mode === 'custody') {
    const flags = `${plan.hide ? 'h' : 'n'}${plan.modes.map(value => value === 'pipe' ? 'p' : 'i').join('')}`;
    packetText = ['1', 'supervise', nonce, jobName, journalFile, plan.app, plan.commandLine, plan.cwd, plan.envBlock, flags, bindingSha].map(b64).join('.');
    if (packetText.length + preparation.assembly.length > LIMITS.packet_chars) mode = 'census-only';
    else packetSha = sha(packetText);
  }
  const reason = mode === 'custody' ? null : 'process-tree-custody-unavailable';
  const unsupported = mode === 'custody' ? null : (plan.supported ? (preparation?.assembly ? 'packet-size' : 'preparation') : plan.reason);
  const header = { kind: 'header', record: RECORD_VERSION, methods: [CUSTODY_METHOD, CENSUS_METHOD], mode, reason_code: reason,
    unsupported, binding: fixed, binding_sha256: bindingSha, nonce, job_name: mode === 'custody' ? jobName : null,
    packet_sha256: packetSha, platform: process.platform, created_ms: Date.now() };
  const origin = { key, recordFile, journalFile, mode, nonce, jobName, binding: fixed, bindingSha, packetSha, child: null,
    assembly: mode === 'custody' ? preparation.assembly : null, record: createRecord(recordFile, header), recordBroken: false,
    ctrl: [], ctrlBytes: Buffer.alloc(0), ctrlPending: Buffer.alloc(0), ctrlInvalid: false, ctrlEnded: false,
    identities: [], samples: 0, sampler: null, joined: null, spawnedAt: Date.now(),
    sizes: mode === 'custody' ? { packet_chars: packetText.length, assembly_chars: preparation.assembly.length, env_chars: plan.envBlock.length, env_entries: plan.env_entries } : null };
  let child;
  if (mode === 'census-only') {
    try { child = plainSpawn(command, args, options); }
    catch (error) { safeAppend(origin, { kind: 'spawn-failed', mode }); throw error; }
  } else {
    const stdio = [plan.modes[0], 'ignore', 'ignore', 'pipe', plan.modes[1] === 'pipe' ? 'pipe' : 'ignore', plan.modes[2] === 'pipe' ? 'pipe' : 'ignore'];
    try {
      child = cp.spawn(POWERSHELL, SUPERVISOR_ARGS, { cwd: NEUTRAL_CWD, shell: false, windowsHide: plan.hide, stdio,
        env: chunkEnv(`${preparation.assembly}:${packetText}`) });
    } catch {
      safeAppend(origin, { kind: 'spawn-failed', mode });
      const error = new ProcessTreeError('process-tree-custody-failed');
      custodyFailures.add(error);
      throw error;
    }
    const ctrl = child.stdio[3];
    const out = child.stdio[4] || null, err = child.stdio[5] || null;
    child.stdout = out; child.stderr = err;
    child.stdio = [child.stdio[0], out, err];
    if (ctrl) {
      ctrl.on('data', chunk => consumeCtrl(origin, chunk));
      ctrl.on('end', () => { origin.ctrlEnded = true; });
      ctrl.on('close', () => { origin.ctrlEnded = true; });
      ctrl.on('error', () => { origin.ctrlInvalid = true; });
    } else origin.ctrlInvalid = true;
  }
  origin.child = child;
  origins.set(key, origin);
  safeAppend(origin, { kind: 'spawned', mode, pid: Number.isSafeInteger(child.pid) ? child.pid : null });
  scheduleSamples(origin, input.sampleIntervalMs);
  const tree = Object.freeze({ mode, method: mode === 'custody' ? CUSTODY_METHOD : CENSUS_METHOD, recordFile, journalFile,
    sizes: origin.sizes ? Object.freeze({ ...origin.sizes }) : null,
    join: () => joinTree(origin), prove: options2 => proveDescendantsStopped({ recordFile, binding: fixed, ...(options2 || {}) }) });
  return { child, tree };
}
function scheduleSamples(origin, intervalMs = DEFAULT_SAMPLE_INTERVAL_MS) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) return;
  const take = () => {
    if (origin.joined || origin.samples >= LIMITS.samples || origin.recordBroken) return;
    origin.samples++;
    snapshotAsync().then(census => {
      if (origin.joined) return;
      const pid = origin.mode === 'custody' ? ctrlEvent(origin, 'custody-established')?.root_pid : origin.child?.pid;
      const found = census.status === 'ok' && Number.isSafeInteger(pid) ? descendantsOf(census.rows, pid) : [];
      for (const identity of found) if (!origin.identities.some(([p, s]) => p === identity[0] && s === identity[1]) && origin.identities.length < LIMITS.identities) origin.identities.push(identity);
      safeAppend(origin, { kind: 'sample', status: census.status, count: census.rows ? census.rows.length : 0, identities: found });
    }).catch(() => {});
    if (origin.child && origin.child.exitCode === null && origin.child.signalCode === null) {
      origin.sampler = setTimeout(take, intervalMs); origin.sampler.unref?.();
    }
  };
  // Census-only attempts sample immediately (it is all they have); custody
  // attempts only add periodic diagnostics.
  origin.sampler = setTimeout(take, origin.mode === 'census-only' ? 0 : intervalMs);
  origin.sampler.unref?.();
}
function childRunning(child) { return !!child && child.exitCode === null && child.signalCode === null; }
async function joinTree(origin) {
  if (origin.joined) return origin.joined;
  clearTimeout(origin.sampler);
  const until = Date.now() + LIMITS.ctrl_wait_ms;
  while (origin.mode === 'custody' && !origin.ctrlEnded && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  let status = 'unknown', reason = 'process-tree-custody-unproved';
  try {
    const family = ctrlEvent(origin, 'family-empty');
    if (origin.mode === 'custody' && family && !childRunning(origin.child) && journalMatches(origin, true)) {
      // The live supervisor observed the empty job before it exited.
      status = 'stopped'; reason = null;
    } else {
      const proof = proveDescendantsStopped({ recordFile: origin.recordFile, binding: origin.binding });
      status = proof.status; reason = proof.reason_code;
    }
  } catch { status = 'unknown'; reason = 'process-tree-unavailable'; }
  origin.joined = { status, reason };
  safeAppend(origin, { kind: 'join', status, method: origin.mode === 'custody' ? CUSTODY_METHOD : CENSUS_METHOD, reason_code: reason,
    journal_sha256: origin.mode === 'custody' ? sha(origin.ctrlBytes) : null });
  let recordSha = null;
  try { const read = readBounded(origin.recordFile, LIMITS.record_bytes); recordSha = read && !origin.recordBroken && read.bytes.equals(origin.record.bytes) ? sha(read.bytes) : null; } catch { recordSha = null; }
  return (origin.joined = Object.freeze({ status: recordSha ? status : 'unknown', method: origin.mode === 'custody' ? CUSTODY_METHOD : CENSUS_METHOD, record_sha256: recordSha }));
}
// The journal on disk must carry exactly the genuine lines received from the
// live supervisor on its private pipe. Only lines from that pipe are evidence.
// The supervisor writes disk first, pipe second: while it runs (or while its pipe
// is not drained) the disk may be ahead; after a kill between the two writes the
// disk may hold ONE extra (possibly torn) line, never after a terminal event.
function journalMatches(origin, complete) {
  const read = readBounded(origin.journalFile, LIMITS.journal_bytes);
  if (!read || !read.bytes.subarray(0, origin.ctrlBytes.length).equals(origin.ctrlBytes)) return false;
  const rest = read.bytes.subarray(origin.ctrlBytes.length);
  if (!rest.length) return true;
  const breaks = [...rest].filter(byte => byte === 10).length, torn = rest.at(-1) !== 10;
  if (!complete) return breaks + (torn ? 1 : 0) <= 4;
  const terminal = origin.ctrl.some(item => ['family-empty', 'family-unproved', 'custody-failed'].includes(item.row.event));
  return !terminal && breaks + (torn ? 1 : 0) === 1;
}

// ── Proof ───────────────────────────────────────────────────────────────────
// Pure evaluator of a custody origin against one native observation.
function evaluateCustody(facts, observed) {
  const unknown = code => ({ status: 'unknown', reason_code: code });
  if (facts.failed) return unknown('process-tree-custody-failed');
  if (!facts.started || !facts.established) return unknown('process-tree-custody-unproved');
  if (!observed) return unknown('process-tree-unavailable');
  if (observed.session !== facts.session || observed.appcontainer !== facts.appcontainer || facts.appcontainer === -1) return unknown('process-tree-custody-unproved');
  const state = pid => observed.ids.find(row => row.pid === pid)?.state;
  const gone = value => value === 'absent' || value === 'exited' || value === 'reused';
  const supervisor = state(facts.supervisor_pid), root = state(facts.root_pid);
  // The current observation must bind both registered identities (pid + creation).
  if (supervisor === undefined || root === undefined || supervisor === 'denied' || root === 'denied'
      || supervisor === 'error' || root === 'error') return unknown('process-tree-root-unbound');
  if (observed.job === 'open') {
    if (observed.flags !== JOB_FLAGS) return unknown('process-tree-custody-unproved');
    if (observed.active > 0) return { status: 'alive', reason_code: 'process-tree-survivors', active: observed.active };
    if (root === 'alive') return { status: 'alive', reason_code: 'process-tree-survivors', active: 1 };
    return { status: 'stopped', reason_code: null, active: 0 };
  }
  if (observed.job === 'absent') {
    if (root === 'alive') return { status: 'alive', reason_code: 'process-tree-survivors', active: 1 };
    if (facts.unproved || facts.job_flags !== JOB_FLAGS || facts.supervisorRunning || !gone(supervisor) || !gone(root)) return unknown('process-tree-custody-unproved');
    return { status: 'stopped', reason_code: null, active: 0 };
  }
  return unknown('process-tree-custody-unproved');
}
function readRecordFor(recordFile, binding) {
  const read = readBounded(recordFile, LIMITS.record_bytes);
  if (!read) fail('process-tree-record-missing');
  const rows = recordLines(read.bytes), header = rows[0];
  if (header?.kind !== 'header' || header.record !== RECORD_VERSION || !['custody', 'census-only'].includes(header.mode)
      || !validBinding(header.binding) || header.binding_sha256 !== digest(canonicalBinding(header.binding))) fail('process-tree-record-invalid');
  if (!validBinding(binding) || digest(canonicalBinding(binding)) !== header.binding_sha256) fail('process-tree-binding-mismatch');
  return { read, rows, header };
}
function proveDescendantsStopped(input = {}) {
  const { recordFile, binding } = input;
  const finish = (result, origin, read) => {
    const evidence = { record_sha256: read ? sha(read.bytes) : null, journal_sha256: origin && origin.mode === 'custody' ? sha(origin.ctrlBytes) : null,
      binding_sha256: origin ? origin.bindingSha : null, active: Number.isSafeInteger(result.active) ? result.active : null,
      observation_ms: Number.isSafeInteger(result.observation_ms) ? result.observation_ms : null };
    const value = deepFreeze({ status: result.status, reason_code: result.reason_code, method: origin?.mode === 'custody' ? CUSTODY_METHOD : CENSUS_METHOD, evidence });
    const handle = Object.freeze({ kind: 'process-tree-proof' });
    proofs.set(handle, { recordFile, binding: validBinding(binding) ? canonicalBinding(binding) : null, value });
    return Object.freeze({ ...value, handle });
  };
  let parsed, origin = null;
  try {
    if (typeof recordFile !== 'string' || !path.isAbsolute(recordFile)) fail('process-tree-record-missing');
    parsed = readRecordFor(recordFile, binding);
    origin = origins.get(recordKey(recordFile)) || null;
  } catch (error) { return finish({ status: 'unknown', reason_code: error instanceof ProcessTreeError ? error.code : 'process-tree-record-invalid' }, null, null); }
  // No live origin in THIS process (restart, forged or foreign record): unknown.
  if (!origin || origin.bindingSha !== parsed.header.binding_sha256 || origin.nonce !== parsed.header.nonce) {
    return finish({ status: 'unknown', reason_code: parsed.header.mode === 'custody' ? 'process-tree-custody-unproved' : 'process-tree-custody-unavailable' }, null, parsed.read);
  }
  if (origin.recordBroken || !parsed.read.bytes.equals(origin.record.bytes)) return finish({ status: 'unknown', reason_code: 'process-tree-record-invalid' }, origin, parsed.read);
  if (origin.mode === 'census-only') {
    const census = snapshot({ timeoutMs: input.timeoutMs });
    return finish(evaluateCensus(origin.identities, census, childRunning(origin.child)), origin, parsed.read);
  }
  if (origin.ctrlInvalid) return finish({ status: 'unknown', reason_code: 'process-tree-record-invalid' }, origin, parsed.read);
  try { if (!journalMatches(origin, origin.ctrlEnded && !childRunning(origin.child))) return finish({ status: 'unknown', reason_code: 'process-tree-record-invalid' }, origin, parsed.read); }
  catch { return finish({ status: 'unknown', reason_code: 'process-tree-record-invalid' }, origin, parsed.read); }
  const started = ctrlEvent(origin, 'supervisor-started'), established = ctrlEvent(origin, 'custody-established');
  const facts = { started: !!started, established: !!established, failed: !!ctrlEvent(origin, 'custody-failed'), unproved: !!ctrlEvent(origin, 'family-unproved'),
    session: started?.session, appcontainer: started?.appcontainer, supervisor_pid: started?.supervisor_pid, root_pid: established?.root_pid,
    job_flags: established?.job_flags, supervisorRunning: childRunning(origin.child) };
  if (!facts.started || !facts.established || facts.failed) return finish(evaluateCustody(facts, null), origin, parsed.read);
  const observed = runObserver(origin.assembly, origin.jobName, [[started.supervisor_pid, started.supervisor_created], [established.root_pid, established.root_created]], input.timeoutMs);
  const result = evaluateCustody(facts, observed);
  if (observed) result.observation_ms = observed.duration_ms;
  return finish(result, origin, parsed.read);
}
// Re-observes live. Throws when the status left `stopped`, when record/journal
// bytes or the binding changed, or when the handle is not a live proof handle.
function assertDescendants(handle) {
  const held = handle && typeof handle === 'object' ? proofs.get(handle) : undefined;
  if (!held || !held.binding) fail('process-tree-record-invalid');
  const next = proveDescendantsStopped({ recordFile: held.recordFile, binding: held.binding });
  const was = held.value;
  if (next.reason_code === 'process-tree-record-invalid' || next.reason_code === 'process-tree-binding-mismatch') fail(next.reason_code);
  if (next.evidence.record_sha256 !== was.evidence.record_sha256) fail('process-tree-record-invalid');
  if (next.evidence.journal_sha256 !== was.evidence.journal_sha256) fail('process-tree-record-invalid');
  if (next.status !== was.status) fail(next.reason_code || 'process-tree-custody-unproved');
  return next;
}
function isSpawnError(error) { return !!error && typeof error === 'object' && spawnErrors.has(error); }
function isCustodyFailure(error) { return !!error && typeof error === 'object' && custodyFailures.has(error); }

module.exports = {
  CUSTODY_METHOD, CENSUS_METHOD, RECORD_VERSION, REASON_CODES, LIMITS, DEFAULT_SAMPLE_INTERVAL_MS, RESERVED_EXIT,
  NATIVE_SOURCE, NATIVE_SHA256, POWERSHELL, SUPERVISOR_ARGS,
  prepareCustody, preparationStatus, nativeAssembly, startAttemptTree, snapshot, proveDescendantsStopped, assertDescendants,
  identities, isSpawnError, isCustodyFailure,
  internals: Object.freeze({ quoteArgument, commandLine, effectiveEnvironment, resolveExecutable, planCustody, stdioModes,
    evaluateCustody, evaluateCensus, parseCensus, descendantsOf, recordLines, validBinding, observerRuns: () => observerRuns }),
};
