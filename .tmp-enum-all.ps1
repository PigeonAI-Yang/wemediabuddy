$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class EnumWins2 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static List<string> Run() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      var cls = new StringBuilder(256);
      GetClassName(h, cls, cls.Capacity);
      var c = cls.ToString();
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      int w = r.Right - r.Left; int ht = r.Bottom - r.Top;
      if (w < 200 || ht < 200) return true;
      var title = new StringBuilder(512);
      GetWindowText(h, title, title.Capacity);
      int style = GetWindowLong(h, -16);
      bool vis = IsWindowVisible(h);
      list.Add(pid + "\tvis=" + vis + "\t" + w + "x" + ht + "\t@" + r.Left + "," + r.Top + "\t" + c + "\t" + title.ToString() + "\tstyle=" + style);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
[EnumWins2]::Run() | ForEach-Object { $_ }
