$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class CloakEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  const int DWMWA_CLOAKED = 14;
  const uint WM_CLOSE = 0x0010;
  public static List<string> Run(bool closeSuspects) {
    var list = new List<string>();
    EnumWindows((h, l) => {
      RECT r; GetWindowRect(h, out r);
      int w=r.Right-r.Left, ht=r.Bottom-r.Top;
      if (w < 400 || ht < 300) return true;
      if (r.Left <= -10000 && r.Top <= -10000) return true;
      var title = new StringBuilder(512); GetWindowText(h, title, title.Capacity);
      var cls = new StringBuilder(256); GetClassName(h, cls, cls.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      int cloaked = 0;
      try { DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4); } catch { cloaked = -1; }
      bool vis = IsWindowVisible(h);
      bool iconic = IsIconic(h);
      string c = cls.ToString();
      string t = title.ToString();
      bool chrome = c.StartsWith("Chrome_WidgetWin") || c.Contains("Electron") || c == "Tauri Window";
      bool emptyTitle = string.IsNullOrWhiteSpace(t);
      // suspect blank app frames on primary area
      bool onPrimary = r.Left < 3000 && r.Top < 1200 && r.Right > 100 && r.Bottom > 100;
      if ((chrome || emptyTitle) && onPrimary && (vis || cloaked != 0)) {
        string mark = "pid=" + pid + " hwnd=" + h.ToInt64() + " " + w + "x" + ht + " @(" + r.Left + "," + r.Top + ") vis=" + vis + " cloak=" + cloaked + " iconic=" + iconic + " cls=" + c + " title=[" + t + "]";
        if (closeSuspects && chrome && emptyTitle && !iconic && w >= 800 && ht >= 500 && r.Left >= 0 && r.Left < 2000) {
          PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
          mark += " ACTION=WM_CLOSE";
        }
        list.Add(mark);
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
Write-Output '=== SUSPECTS ==='
[CloakEnum]::Run($false) | ForEach-Object { $_ }
Write-Output '=== CLOSE EMPTY CHROME ON LEFT ==='
[CloakEnum]::Run($true) | ForEach-Object { $_ }
