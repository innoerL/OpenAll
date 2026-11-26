param([switch]$Focus)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OpenAllDesktopCheck {
 [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string name, string title);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
 public static IntPtr Icons() {
  // 新旧资源管理器可能把桌面图标托管在不同的顶层窗口下。
  IntPtr root = IntPtr.Zero;
  while ((root = FindWindowEx(IntPtr.Zero, root, null, null)) != IntPtr.Zero) {
   var view = FindWindowEx(root, IntPtr.Zero, "SHELLDLL_DefView", null);
   if (view == IntPtr.Zero) continue;
   var icons = FindWindowEx(view, IntPtr.Zero, "SysListView32", null);
   if (icons != IntPtr.Zero) return icons;
  }
  return IntPtr.Zero;
 }
}
'@
$shell = [OpenAllDesktopCheck]::GetShellWindow()
$icons = [OpenAllDesktopCheck]::Icons()
if ($Focus) {
    (New-Object -ComObject Shell.Application).MinimizeAll()
    Start-Sleep -Milliseconds 300
    $root = [OpenAllDesktopCheck]::GetAncestor($icons, 2)
    $foreground = [OpenAllDesktopCheck]::GetForegroundWindow()
    if ($foreground -ne $root -and $foreground -ne $shell -and $shell -ne [IntPtr]::Zero) {
        [void][OpenAllDesktopCheck]::SetForegroundWindow($shell)
    }
}
@{
    shell = $shell.ToInt64().ToString()
    icons = $icons.ToInt64().ToString()
    iconsVisible = [OpenAllDesktopCheck]::IsWindowVisible($icons)
} | ConvertTo-Json -Compress
