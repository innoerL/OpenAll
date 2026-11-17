$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Emit($value) { [Console]::WriteLine(($value | ConvertTo-Json -Compress -Depth 12));[Console]::Out.Flush() }
$bootClock=[Diagnostics.Stopwatch]::StartNew()
Emit @{event='boot';data=@{stage='powershell';elapsedMS=$bootClock.ElapsedMilliseconds}}
Add-Type -AssemblyName System.Windows.Forms
Emit @{event='boot';data=@{stage='winforms';elapsedMS=$bootClock.ElapsedMilliseconds}}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;
using System.Collections.Concurrent;
using System.Threading;
public static class OpenAllNative {
 static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
 public static volatile bool ReaderEnded;
 public static void StartReader() { var t=new Thread(()=>{string line;while((line=Console.ReadLine())!=null)Lines.Enqueue(line);ReaderEnded=true;});t.IsBackground=true;t.Start(); }
 public static string NextLine() {string line;return Lines.TryDequeue(out line)?line:null;}
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int cmd);
 [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a,uint b,bool attach);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
 [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy;public uint mouseData,dwFlags,time;public UIntPtr dwExtraInfo; }
 [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk,wScan;public uint dwFlags,time;public UIntPtr dwExtraInfo; }
 [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint count,INPUT[] inputs,int size);
 public static uint ProcessId(IntPtr h) { uint pid;GetWindowThreadProcessId(h,out pid);return pid; }
 public static string ProcessName(IntPtr h) { try{return Process.GetProcessById((int)ProcessId(h)).ProcessName;}catch{return "";} }
 public static string ProcessPath(IntPtr h) { try{return Process.GetProcessById((int)ProcessId(h)).MainModule.FileName;}catch{return "";} }
 public static bool Foreground(IntPtr h) { if(!IsWindow(h))return false;uint pid;uint target=GetWindowThreadProcessId(h,out pid), current=GetCurrentThreadId();AttachThreadInput(current,target,true);ShowWindow(h,9);bool ok=SetForegroundWindow(h);AttachThreadInput(current,target,false);return ok; }
 public static bool Key(ushort key) {INPUT[] a=new INPUT[4];a[0].type=a[1].type=a[2].type=a[3].type=1;a[0].u.ki.wVk=0x11;a[1].u.ki.wVk=key;a[2].u.ki.wVk=key;a[2].u.ki.dwFlags=2;a[3].u.ki.wVk=0x11;a[3].u.ki.dwFlags=2;return SendInput(4,a,Marshal.SizeOf(typeof(INPUT)))==4;}
}
'@
Emit @{event='boot';data=@{stage='interop';elapsedMS=$bootClock.ElapsedMilliseconds}}
function WaitModifiers { for($attempt=0;$attempt -lt 40;$attempt++){if((([OpenAllNative]::GetAsyncKeyState(17) -bor [OpenAllNative]::GetAsyncKeyState(18) -bor [OpenAllNative]::GetAsyncKeyState(16)) -band 0x8000) -eq 0){break};Start-Sleep -Milliseconds 20} }
# 独立验证只在隔离 CI 中调用，原剪贴板在 finally 中恢复。
function TestNative {
 $original=[Windows.Forms.Clipboard]::GetDataObject();$saved=[Windows.Forms.DataObject]::new()
 if($original){foreach($format in $original.GetFormats($false)){try{$value=$original.GetData($format,$false);if($value -is [IO.MemoryStream]){$value=[IO.MemoryStream]::new($value.ToArray())}elseif($value -is [Drawing.Image]){$value=$value.Clone()};$saved.SetData($format,$false,$value)}catch{}}}
 $file=[IO.Path]::GetTempFileName();$form=[Windows.Forms.Form]::new();$form.Text='OpenAll Native Test';$form.Width=600;$form.Height=240;$form.StartPosition='CenterScreen';$form.TopMost=$true
 $textBox=[Windows.Forms.TextBox]::new();$textBox.Multiline=$true;$textBox.Dock='Fill';$form.Controls.Add($textBox)
 try {
  $form.Show();$form.Activate();[void][OpenAllNative]::Foreground($form.Handle);[void]$textBox.Focus();[Windows.Forms.Application]::DoEvents()
  [Windows.Forms.Clipboard]::SetText('OpenAll Native Paste 12345');[void][OpenAllNative]::Key(0x56)
  for($i=0;$i -lt 30;$i++){[Windows.Forms.Application]::DoEvents();Start-Sleep -Milliseconds 20;if($textBox.Text -eq 'OpenAll Native Paste 12345'){break}}
  if($textBox.Text -ne 'OpenAll Native Paste 12345'){throw 'SendInput 粘贴验证失败'}
  $textBox.Select(8,6);[void][OpenAllNative]::Key(0x43)
  for($i=0;$i -lt 30;$i++){[Windows.Forms.Application]::DoEvents();Start-Sleep -Milliseconds 20;if([Windows.Forms.Clipboard]::GetText() -eq 'Native'){break}}
  if([Windows.Forms.Clipboard]::GetText() -ne 'Native'){throw 'SendInput 选区复制验证失败'}
  $files=[Collections.Specialized.StringCollection]::new();[void]$files.Add($file);[Windows.Forms.Clipboard]::SetFileDropList($files)
  if([Windows.Forms.Clipboard]::GetFileDropList()[0] -ne $file){throw '文件剪贴板验证失败'}
  $bitmap=[Drawing.Bitmap]::new(760,160);$graphics=[Drawing.Graphics]::FromImage($bitmap);$font=[Drawing.Font]::new('Arial',32,[Drawing.FontStyle]::Regular)
  try {$graphics.Clear([Drawing.Color]::White);$graphics.DrawString('OPENALL WINDOWS OCR 12345',$font,[Drawing.Brushes]::Black,[Drawing.PointF]::new(12,45));[Windows.Forms.Clipboard]::SetImage($bitmap);$fromClipboard=[Windows.Forms.Clipboard]::GetImage();if($fromClipboard.Width -ne 760){throw '图片剪贴板验证失败'};$fromClipboard.Dispose();$stream=[IO.MemoryStream]::new();try{$bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png);$png=[Convert]::ToBase64String($stream.ToArray())}finally{$stream.Dispose()}}finally{$graphics.Dispose();$font.Dispose();$bitmap.Dispose()}
  return @{paste=$true;selection=$true;files=$true;image=$true;ocrImage=$png;inputSize=[Runtime.InteropServices.Marshal]::SizeOf([type][OpenAllNative+INPUT])}
 } finally {$form.Close();$form.Dispose();[IO.File]::Delete($file);if($original){[Windows.Forms.Clipboard]::SetDataObject($saved,$true)}else{[Windows.Forms.Clipboard]::Clear()}}
}
$lastHandle = [IntPtr]::Zero
$lastSequence = [OpenAllNative]::GetClipboardSequenceNumber()
$keys = @{ Alt=18; Control=17; Shift=16; Super=91 }
$down = @{}; $released=@{}; $used=@{}
[OpenAllNative]::StartReader()
Emit @{event='ready';data=@{native=$true;elapsedMS=$bootClock.ElapsedMilliseconds}}
while ($true) {
 $line=[OpenAllNative]::NextLine()
 if ($null -ne $line) {
  try {
   $request=$line | ConvertFrom-Json; $payload=$request.payload; $result=$null
   switch ($request.action) {
    'selfTest' { $result=TestNative }
    'foreground' { $h=[OpenAllNative]::GetForegroundWindow();$result=@{handle=$h.ToInt64().ToString();pid=[OpenAllNative]::ProcessId($h);name=[OpenAllNative]::ProcessName($h);exePath=[OpenAllNative]::ProcessPath($h)} }
    'paste' { WaitModifiers;$h=[IntPtr]([long]$payload.handle);if(-not [OpenAllNative]::Foreground($h)){throw '无法恢复原窗口焦点'};Start-Sleep -Milliseconds 100;$result=[OpenAllNative]::Key(0x56) }
    'copy' { WaitModifiers;$h=[IntPtr]([long]$payload.handle);if(-not [OpenAllNative]::Foreground($h)){throw '无法恢复原窗口焦点'};Start-Sleep -Milliseconds 70;$result=[OpenAllNative]::Key(0x43) }
    'captureSelection' {
     WaitModifiers
     $original=[Windows.Forms.Clipboard]::GetDataObject();$saved=[Windows.Forms.DataObject]::new()
     if($original){foreach($format in $original.GetFormats($false)){try{$value=$original.GetData($format,$false);if($value -is [IO.MemoryStream]){$value=[IO.MemoryStream]::new($value.ToArray())}elseif($value -is [Drawing.Image]){$value=$value.Clone()};$saved.SetData($format,$false,$value)}catch{}}}
     $before=[OpenAllNative]::GetClipboardSequenceNumber();$h=[IntPtr]([long]$payload.handle)
     try {
      if(-not [OpenAllNative]::Foreground($h)){throw '无法恢复原窗口焦点'}
      Start-Sleep -Milliseconds 70
      if(-not [OpenAllNative]::Key(0x43)){throw '无法发送复制按键'}
      for($attempt=0;$attempt -lt 30;$attempt++){Start-Sleep -Milliseconds 20;if([OpenAllNative]::GetClipboardSequenceNumber() -ne $before){break}}
      if([OpenAllNative]::GetClipboardSequenceNumber() -eq $before){$result=@{kind='text';text=''}}
      elseif([Windows.Forms.Clipboard]::ContainsFileDropList()){$result=@{kind='files';files=@([Windows.Forms.Clipboard]::GetFileDropList())}}
      elseif([Windows.Forms.Clipboard]::ContainsImage()){$image=[Windows.Forms.Clipboard]::GetImage();$stream=[IO.MemoryStream]::new();try{$image.Save($stream,[Drawing.Imaging.ImageFormat]::Png);$result=@{kind='image';dataUrl='data:image/png;base64,'+[Convert]::ToBase64String($stream.ToArray())}}finally{$stream.Dispose();$image.Dispose()}}
      else{$result=@{kind='text';text=[Windows.Forms.Clipboard]::GetText()}}
     } finally {if($original){[Windows.Forms.Clipboard]::SetDataObject($saved,$true)}else{[Windows.Forms.Clipboard]::Clear()}}
    }
    'files' { $result=@([Windows.Forms.Clipboard]::GetFileDropList()) }
    'writeFiles' { $collection=[Collections.Specialized.StringCollection]::new();foreach($file in $payload.files){[void]$collection.Add([string]$file)};[Windows.Forms.Clipboard]::SetFileDropList($collection);$result=$true }
    'quit' { Emit @{id=$request.id;result=$true};exit }
    default { throw '未知原生操作' }
   }
   Emit @{id=$request.id;result=$result}
  } catch { Emit @{id=$request.id;error=$_.Exception.Message} }
 }
 if([OpenAllNative]::ReaderEnded -and $null -eq $line){break}
 $h=[OpenAllNative]::GetForegroundWindow()
 if($h -ne $lastHandle){$lastHandle=$h;Emit @{event='foreground';data=@{handle=$h.ToInt64().ToString();pid=[OpenAllNative]::ProcessId($h);name=[OpenAllNative]::ProcessName($h);exePath=[OpenAllNative]::ProcessPath($h)}}}
 $seq=[OpenAllNative]::GetClipboardSequenceNumber()
 if($seq -ne $lastSequence){$lastSequence=$seq;Emit @{event='clipboard';data=$seq}}
 $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
 foreach($name in $keys.Keys){
  $pressed=([OpenAllNative]::GetAsyncKeyState($keys[$name]) -band 0x8000) -ne 0
  if($pressed -and -not $down[$name]){$down[$name]=$now;$used[$name]=$false}
  if($pressed){for($key=48;$key -le 90;$key++){if($key -notin @(91,92) -and ([OpenAllNative]::GetAsyncKeyState($key) -band 0x8000)){$used[$name]=$true;break}}}
  if(-not $pressed -and $down[$name]){if(-not $used[$name] -and $now-$down[$name] -lt 450){if($released[$name] -and $now-$released[$name] -lt 350){Emit @{event='doubleTap';data=$name};$released[$name]=0}else{$released[$name]=$now}};$down[$name]=0}
 }
 Start-Sleep -Milliseconds 25
}
