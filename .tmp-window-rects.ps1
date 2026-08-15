$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
  $h = $_.MainWindowHandle
  $rect = New-Object Win+RECT
  [void][Win]::GetWindowRect($h, [ref]$rect)
  $w = $rect.Right - $rect.Left
  $hgt = $rect.Bottom - $rect.Top
  [PSCustomObject]@{
    Id = $_.Id
    Name = $_.ProcessName
    Title = $_.MainWindowTitle
    Visible = [Win]::IsWindowVisible($h)
    Left = $rect.Left
    Top = $rect.Top
    Width = $w
    Height = $hgt
    Path = $_.Path
  }
} | ConvertTo-Json -Compress
