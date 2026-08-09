$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class FgWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT Point);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; public POINT(int x,int y){X=x;Y=y;} }
  static string Describe(IntPtr h) {
    if (h == IntPtr.Zero) return "null";
    var title = new StringBuilder(512); GetWindowText(h, title, title.Capacity);
    var cls = new StringBuilder(256); GetClassName(h, cls, cls.Capacity);
    uint pid; GetWindowThreadProcessId(h, out pid);
    RECT r; GetWindowRect(h, out r);
    int w=r.Right-r.Left, ht=r.Bottom-r.Top;
    return "hwnd=" + h.ToInt64() + " pid=" + pid + " " + w + "x" + ht + " @(" + r.Left + "," + r.Top + ") vis=" + IsWindowVisible(h) + " iconic=" + IsIconic(h) + " cls=" + cls.ToString() + " title=[" + title.ToString() + "]";
  }
  public static List<string> Run() {
    var list = new List<string>();
    list.Add("FOREGROUND " + Describe(GetForegroundWindow()));
    // sample points on left half of primary
    int[][] pts = new int[][] {
      new int[]{200,200}, new int[]{600,400}, new int[]{1000,500}, new int[]{400,800}, new int[]{800,100}, new int[]{50,50}
    };
    foreach (var p in pts) {
      var h = WindowFromPoint(new POINT(p[0], p[1]));
      list.Add("POINT " + p[0] + "," + p[1] + " -> " + Describe(h));
    }
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      RECT r; GetWindowRect(h, out r);
      int w=r.Right-r.Left, ht=r.Bottom-r.Top;
      if (w < 300 || ht < 300) return true;
      if (r.Left <= -10000) return true;
      // on primary-ish left/center
      if (r.Right < 50 || r.Top > 1400) return true;
      list.Add("VISIBLE " + Describe(h));
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
[FgWin]::Run() | ForEach-Object { $_ }
