$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class EnumWins {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static List<string> Run() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var title = new StringBuilder(512);
      GetWindowText(h, title, title.Capacity);
      var cls = new StringBuilder(256);
      GetClassName(h, cls, cls.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      int w = r.Right - r.Left; int ht = r.Bottom - r.Top;
      if (w < 80 || ht < 80) return true;
      if (r.Left <= -30000) return true;
      list.Add(pid + "\t" + w + "x" + ht + "\t@" + r.Left + "," + r.Top + "\t" + cls.ToString() + "\t" + title.ToString());
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
[EnumWins]::Run() | ForEach-Object { $_ }
