$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Emit($value) { [Console]::WriteLine(($value | ConvertTo-Json -Compress -Depth 12));[Console]::Out.Flush() }
$bootClock=[Diagnostics.Stopwatch]::StartNew()
Emit @{event='boot';data=@{stage='powershell';elapsedMS=$bootClock.ElapsedMilliseconds}}
Add-Type -AssemblyName System.Windows.Forms
Emit @{event='boot';data=@{stage='winforms';elapsedMS=$bootClock.ElapsedMilliseconds}}
Add-Type -AssemblyName WindowsBase,UIAutomationClient,UIAutomationTypes
$interopAssemblies = @('System.dll','System.Core.dll',[System.Windows.Automation.AutomationElement].Assembly.Location,
 [System.Windows.Automation.ControlType].Assembly.Location,[System.Windows.Rect].Assembly.Location)
Add-Type -ReferencedAssemblies $interopAssemblies -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Automation;
public static class OpenAllNative {
 static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
 public static volatile bool ReaderEnded;
 public static void StartReader() { var t=new Thread(()=>{string line;while((line=Console.ReadLine())!=null)Lines.Enqueue(line);ReaderEnded=true;});t.IsBackground=true;t.Start(); }
 public static string NextLine() {string line;return Lines.TryDequeue(out line)?line:null;}
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
 [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder value,int length);
 [DllImport("user32.dll", EntryPoint="GetWindowLongW", ExactSpelling=true)] static extern int GetWindowStyle(IntPtr h,int index);
 [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
 [StructLayout(LayoutKind.Sequential)] struct GuiThreadInfo {
  public uint cbSize, flags;
  public IntPtr active, focus, capture, menu, moveSize, caret;
  public int left, top, right, bottom;
 }
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int cmd);
 [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a,uint b,bool attach);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
 [DllImport("user32.dll")] public static extern bool IsClipboardFormatAvailable(uint format);
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
 [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy;public uint mouseData,dwFlags,time;public UIntPtr dwExtraInfo; }
 [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk,wScan;public uint dwFlags,time;public UIntPtr dwExtraInfo; }
 [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint count,INPUT[] inputs,int size);
 public static uint ProcessId(IntPtr h) { uint pid;GetWindowThreadProcessId(h,out pid);return pid; }
 public static string ProcessName(IntPtr h) { try{return Process.GetProcessById((int)ProcessId(h)).ProcessName;}catch{return "";} }
 public static string ProcessPath(IntPtr h) { try{return Process.GetProcessById((int)ProcessId(h)).MainModule.FileName;}catch{return "";} }
 static string WindowClass(IntPtr h) {
  var name = new StringBuilder(128);
  return GetClassName(h, name, name.Capacity) > 0 ? name.ToString() : "";
 }
 public static bool IsShellSurface(IntPtr h) {
  if (h == IntPtr.Zero || h == GetShellWindow() || h == GetDesktopWindow()) return true;
  string name = WindowClass(h);
  return name == "Progman" || name == "WorkerW" || name == "Shell_TrayWnd" || name == "Shell_SecondaryTrayWnd";
 }
 static Task<bool> inputProbe;
 static bool ProbeEditableFocus(bool fileList) {
  if (inputProbe != null && !inputProbe.IsCompleted) return false;
  // 辅助功能查询可能被别的程序卡住。只等一次短时结果，且不为同一个未完成查询再开线程。
  inputProbe = Task.Factory.StartNew(() => {
   try {
    var target = AutomationElement.FocusedElement;
    if (target == null || !target.Current.IsEnabled || !target.Current.HasKeyboardFocus) return false;
    var type = target.Current.ControlType;
    if (fileList && (type == ControlType.List || type == ControlType.ListItem || type == ControlType.DataGrid)) return true;
    if (type != ControlType.Edit && type != ControlType.Document) return false;
    object pattern;
    if (target.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return !((ValuePattern)pattern).Current.IsReadOnly;
    if (target.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) {
     var text = (TextPattern)pattern;
     var selection = text.GetSelection();
     var range = selection.Length > 0 ? selection[0] : text.DocumentRange;
     return object.Equals(range.GetAttributeValue(TextPattern.IsReadOnlyAttribute), false);
    }
    return false;
   } catch { return false; }
  });
  return inputProbe.Wait(350) && inputProbe.Result;
 }
 static bool ModifiersReleased() {
  return GetAsyncKeyState(17) >= 0 && GetAsyncKeyState(18) >= 0 && GetAsyncKeyState(16) >= 0 &&
    GetAsyncKeyState(91) >= 0 && GetAsyncKeyState(92) >= 0;
 }
 public static bool PasteIfFocused(IntPtr h, uint pid, string kind) {
  if (IsShellSurface(h) || !IsWindowVisible(h) || !IsWindowEnabled(h) || ProcessId(h) != pid) return false;
  // 等抽屉收起后系统自然恢复焦点。避免激活旧窗口，也避免对桌面执行 ShowWindow。
  for (int i=0; i<15 && (GetForegroundWindow() != h || !ModifiersReleased()); i++) Thread.Sleep(20);
  if (GetForegroundWindow() != h || !ModifiersReleased()) return false;
  var info = new GuiThreadInfo { cbSize = (uint)Marshal.SizeOf(typeof(GuiThreadInfo)) };
  if (!GetGUIThreadInfo(0, ref info) || (info.flags & 0x1e) != 0 ||
    info.focus == IntPtr.Zero || GetAncestor(info.focus, 2) != h || !IsWindowEnabled(info.focus)) return false;
  string control = WindowClass(info.focus);
  bool nativeEdit = control.Equals("Edit", StringComparison.OrdinalIgnoreCase) ||
    control.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase) || control.IndexOf(".EDIT.", StringComparison.OrdinalIgnoreCase) >= 0;
  bool eligible = nativeEdit ? (GetWindowStyle(info.focus, -16) & 0x800) == 0 :
    ProbeEditableFocus(kind == "files" && WindowClass(h) == "CabinetWClass");
  var current = new GuiThreadInfo { cbSize = info.cbSize };
  return eligible && GetForegroundWindow() == h && ProcessId(h) == pid && ModifiersReleased() &&
    GetGUIThreadInfo(0, ref current) && current.focus == info.focus && (current.flags & 0x1e) == 0 && Key(0x56);
 }
 public static bool Foreground(IntPtr h) { if(!IsWindow(h))return false;uint pid;uint target=GetWindowThreadProcessId(h,out pid), current=GetCurrentThreadId();AttachThreadInput(current,target,true);ShowWindow(h,9);bool ok=SetForegroundWindow(h);AttachThreadInput(current,target,false);return ok; }
 public static bool Key(ushort key) {INPUT[] a=new INPUT[4];a[0].type=a[1].type=a[2].type=a[3].type=1;a[0].u.ki.wVk=0x11;a[1].u.ki.wVk=key;a[2].u.ki.wVk=key;a[2].u.ki.dwFlags=2;a[3].u.ki.wVk=0x11;a[3].u.ki.dwFlags=2;return SendInput(4,a,Marshal.SizeOf(typeof(INPUT)))==4;}
}
'@
Emit @{event='boot';data=@{stage='interop';elapsedMS=$bootClock.ElapsedMilliseconds}}
function Get-ActiveWindow([IntPtr]$h) {
 return @{handle=$h.ToInt64().ToString();pid=[OpenAllNative]::ProcessId($h);name=[OpenAllNative]::ProcessName($h)
  exePath=[OpenAllNative]::ProcessPath($h);shellSurface=[OpenAllNative]::IsShellSurface($h)}
}
function WaitModifiers { for($attempt=0;$attempt -lt 40;$attempt++){if((([OpenAllNative]::GetAsyncKeyState(17) -bor [OpenAllNative]::GetAsyncKeyState(18) -bor [OpenAllNative]::GetAsyncKeyState(16)) -band 0x8000) -eq 0){break};Start-Sleep -Milliseconds 20} }
function ReadClipboardChange($sequence) {
 $change=@{sequence=$sequence}
 if([OpenAllNative]::IsClipboardFormatAvailable(15)){
  $change.files=[string[]][Windows.Forms.Clipboard]::GetFileDropList()
  if($change.files.Length -eq 0){return $null}
 }
 if($sequence -eq [OpenAllNative]::GetClipboardSequenceNumber()){return $change}
}
function WriteClipboardFiles([string[]]$paths) {
 $collection=[Collections.Specialized.StringCollection]::new()
 $collection.AddRange($paths)
 [Windows.Forms.Clipboard]::SetFileDropList($collection)
}
function Get-LocalPreviewType([string]$file) {
 # 先确认盘符，再从根目录逐级查询。映射盘、联接点和云端占位文件都不参与预览。
 if ($file -notmatch '^[A-Za-z]:[\\/]') {return}
 $root=[IO.Path]::GetPathRoot($file)
 $drive=[IO.DriveInfo]::new($root)
 if ($drive.DriveType -notin @([IO.DriveType]::Fixed,[IO.DriveType]::Removable,[IO.DriveType]::Ram)) {return}
 $current=$root
 $attributes=[IO.FileAttributes]::Directory
 foreach ($part in ($file.Substring($root.Length) -split '[\\/]')) {
  if (-not $part) {continue}
  $current=[IO.Path]::Combine($current,$part)
  $attributes=[IO.File]::GetAttributes($current)
  if (([int]$attributes -band (0x400 -bor 0x1000 -bor 0x40000 -bor 0x400000)) -ne 0) {return}
 }
 if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {return 'folder'}
 return 'file'
}
# 独立验证只在隔离 CI 中调用，原剪贴板在 finally 中恢复。
function TestNative {
 $original=[Windows.Forms.Clipboard]::GetDataObject();$saved=[Windows.Forms.DataObject]::new()
 if($original){foreach($format in $original.GetFormats($false)){try{$value=$original.GetData($format,$false);if($value -is [IO.MemoryStream]){$value=[IO.MemoryStream]::new($value.ToArray())}elseif($value -is [Drawing.Image]){$value=$value.Clone()};$saved.SetData($format,$false,$value)}catch{}}}
 $file=[IO.Path]::GetTempFileName();$form=[Windows.Forms.Form]::new();$form.Text='OpenAll Native Test';$form.Width=600;$form.Height=240;$form.StartPosition='CenterScreen';$form.TopMost=$true
 $textBox=[Windows.Forms.TextBox]::new();$textBox.Multiline=$true;$textBox.Dock='Fill';$form.Controls.Add($textBox)
 $button=[Windows.Forms.Button]::new();$button.Text='测试非输入控件';$button.Dock='Bottom';$form.Controls.Add($button)
 try {
  $form.Show();$form.Activate();[void][OpenAllNative]::Foreground($form.Handle);[void]$textBox.Focus();[Windows.Forms.Application]::DoEvents()
  [Windows.Forms.Clipboard]::SetText('OpenAll Native Paste 12345')
  $desktop=[OpenAllNative]::GetShellWindow()
  if ($desktop -ne [IntPtr]::Zero -and [OpenAllNative]::PasteIfFocused($desktop,[OpenAllNative]::ProcessId($desktop),'files')) {throw '桌面不可接收自动粘贴'}
  if ([OpenAllNative]::PasteIfFocused($form.Handle,0,'text')) {throw '原窗口进程变化时不可发送粘贴'}
  $textBox.ReadOnly=$true
  if ([OpenAllNative]::PasteIfFocused($form.Handle,$PID,'text')) {throw '只读控件不可接收自动粘贴'}
  $textBox.ReadOnly=$false
  [void]$button.Focus();[Windows.Forms.Application]::DoEvents()
  if ([OpenAllNative]::PasteIfFocused($form.Handle,$PID,'text')) {throw '非编辑控件不可接收自动粘贴'}
  [void]$textBox.Focus();[Windows.Forms.Application]::DoEvents()
  if (-not [OpenAllNative]::PasteIfFocused($form.Handle,$PID,'text')) {throw '有效输入框未接收自动粘贴'}
  for($i=0;$i -lt 30;$i++){[Windows.Forms.Application]::DoEvents();Start-Sleep -Milliseconds 20;if($textBox.Text -eq 'OpenAll Native Paste 12345'){break}}
  if($textBox.Text -ne 'OpenAll Native Paste 12345'){throw 'SendInput 粘贴验证失败'}
  $textBox.Select(8,6);[void][OpenAllNative]::Key(0x43)
  for($i=0;$i -lt 30;$i++){[Windows.Forms.Application]::DoEvents();Start-Sleep -Milliseconds 20;if([Windows.Forms.Clipboard]::GetText() -eq 'Native'){break}}
  if([Windows.Forms.Clipboard]::GetText() -ne 'Native'){throw 'SendInput 选区复制验证失败'}
  [string[]]$paths=@($file)
  foreach($count in 1,2){
   if($count -eq 2){$paths+=[IO.Path]::GetDirectoryName($file)}
   WriteClipboardFiles $paths
   $change=ReadClipboardChange ([OpenAllNative]::GetClipboardSequenceNumber())
   $wire=($change | ConvertTo-Json -Compress) | ConvertFrom-Json
   if($wire.files -isnot [Array] -or $wire.files.Length -ne $paths.Length -or ($wire.files -join '|') -ne ($paths -join '|')){throw 'CF_HDROP 文件数组回写验证失败'}
  }
  $bitmap=[Drawing.Bitmap]::new(760,160);$graphics=[Drawing.Graphics]::FromImage($bitmap);$font=[Drawing.Font]::new('Arial',32,[Drawing.FontStyle]::Regular)
  try {$graphics.Clear([Drawing.Color]::White);$graphics.DrawString('OPENALL WINDOWS OCR 12345',$font,[Drawing.Brushes]::Black,[Drawing.PointF]::new(12,45));[Windows.Forms.Clipboard]::SetImage($bitmap);$fromClipboard=[Windows.Forms.Clipboard]::GetImage();if($fromClipboard.Width -ne 760){throw '图片剪贴板验证失败'};$fromClipboard.Dispose();$stream=[IO.MemoryStream]::new();try{$bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png);$png=[Convert]::ToBase64String($stream.ToArray())}finally{$stream.Dispose()}}finally{$graphics.Dispose();$font.Dispose();$bitmap.Dispose()}
  return @{paste=$true;pasteTargetGuard=$true;selection=$true;files=$true;image=$true;ocrImage=$png;inputSize=[Runtime.InteropServices.Marshal]::SizeOf([type][OpenAllNative+INPUT])}
 } finally {$form.Close();$form.Dispose();[IO.File]::Delete($file);if($original){[Windows.Forms.Clipboard]::SetDataObject($saved,$true)}else{[Windows.Forms.Clipboard]::Clear()}}
}
$lastHandle = [IntPtr]::Zero
$lastSequence = $null
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
    'foreground' { $result=Get-ActiveWindow ([OpenAllNative]::GetForegroundWindow()) }
    'paste' { $h=[IntPtr]([long]$payload.handle);$result=[OpenAllNative]::PasteIfFocused($h,[uint32]$payload.pid,[string]$payload.kind) }
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
      elseif([Windows.Forms.Clipboard]::ContainsFileDropList()){$result=@{kind='files';files=[string[]][Windows.Forms.Clipboard]::GetFileDropList()}}
      elseif([Windows.Forms.Clipboard]::ContainsImage()){$image=[Windows.Forms.Clipboard]::GetImage();$stream=[IO.MemoryStream]::new();try{$image.Save($stream,[Drawing.Imaging.ImageFormat]::Png);$result=@{kind='image';dataUrl='data:image/png;base64,'+[Convert]::ToBase64String($stream.ToArray())}}finally{$stream.Dispose();$image.Dispose()}}
      else{$result=@{kind='text';text=[Windows.Forms.Clipboard]::GetText()}}
     } finally {if($original){[Windows.Forms.Clipboard]::SetDataObject($saved,$true)}else{[Windows.Forms.Clipboard]::Clear()};$lastSequence=[OpenAllNative]::GetClipboardSequenceNumber()}
    }
    'files' { $result=[string[]][Windows.Forms.Clipboard]::GetFileDropList() }
    'localPreviewType' { $result=Get-LocalPreviewType $payload.path }
    'writeFiles' { WriteClipboardFiles $payload.files;$result=$true }
    'quit' { Emit @{id=$request.id;result=$true};exit }
    default { throw '未知原生操作' }
   }
   Emit @{id=$request.id;result=$result}
  } catch { Emit @{id=$request.id;error=$_.Exception.Message} }
 }
 if([OpenAllNative]::ReaderEnded -and $null -eq $line){break}
 $h=[OpenAllNative]::GetForegroundWindow()
 if($h -ne $lastHandle){$lastHandle=$h;Emit @{event='foreground';data=(Get-ActiveWindow $h)}}
 $seq=[OpenAllNative]::GetClipboardSequenceNumber()
 if($seq -ne $lastSequence){
  # 在同一次变更中读取 CF_HDROP，避免稍后查询时路径已被下一次复制覆盖。
  try {
   $change=ReadClipboardChange $seq
   if($null -ne $change){
    Emit @{event='clipboard';data=$change}
    $lastSequence=$seq
   }
  } catch { }
 }
 $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
 foreach($name in $keys.Keys){
  $pressed=([OpenAllNative]::GetAsyncKeyState($keys[$name]) -band 0x8000) -ne 0
  if($pressed -and -not $down[$name]){$down[$name]=$now;$used[$name]=$false}
  if($pressed){for($key=48;$key -le 90;$key++){if($key -notin @(91,92) -and ([OpenAllNative]::GetAsyncKeyState($key) -band 0x8000)){$used[$name]=$true;break}}}
  if(-not $pressed -and $down[$name]){if(-not $used[$name] -and $now-$down[$name] -lt 450){if($released[$name] -and $now-$released[$name] -lt 350){Emit @{event='doubleTap';data=$name};$released[$name]=0}else{$released[$name]=$now}};$down[$name]=0}
 }
 Start-Sleep -Milliseconds 25
}
