
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class C {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public struct RECT { public int L,T,R,B; }
}
"@
[C]::EnumWindows({
  param($h,$l)
  $r = New-Object C+RECT
  [void][C]::GetWindowRect($h,[ref]$r)
  $w=$r.R-$r.L; $ht=$r.B-$r.T
  if($w -lt 600 -or $ht -lt 400){ return $true }
  if($r.L -lt -5000){ return $true }
  $t=New-Object Text.StringBuilder 256; [void][C]::GetWindowText($h,$t,256)
  $c=New-Object Text.StringBuilder 256; [void][C]::GetClassName($h,$c,256)
  $cls=$c.ToString()
  if($cls -notmatch 'Chrome_WidgetWin|Electron'){ return $true }
  if($t.ToString().Trim() -ne ''){ return $true }
  $pid=0; [void][C]::GetWindowThreadProcessId($h,[ref]$pid)
  [void][C]::PostMessage($h,0x10,[IntPtr]::Zero,[IntPtr]::Zero)
  Write-Output "CLOSE pid=$pid hwnd=$h $w`x$ht @($($r.L),$($r.T)) $cls"
  return $true
}, [IntPtr]::Zero)
